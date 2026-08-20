import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseSetupCommandOptions } from "../options.ts";
import { runScoutSetup } from "../../core/setup/service.ts";
import { renderScoutSetupReport } from "../../ui/terminal/setup.ts";
import { readOpenScoutSettings } from "@openscout/runtime/setup";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

type SourceRootPrompt = (suggestedRoot: string, additionalRootCount: number) => Promise<string>;

function findGitRoot(startDirectory: string): string | null {
  let current = resolve(startDirectory);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function suggestProjectSourceRoot(
  currentDirectory: string,
  homeDirectory = homedir(),
): string {
  const gitRoot = findGitRoot(currentDirectory);
  // A dotfiles repo at ~/.git would otherwise suggest the parent of home
  // (`/Users`), which is never where anyone keeps projects.
  if (gitRoot && resolve(gitRoot) !== resolve(homeDirectory)) return dirname(gitRoot);

  for (const candidate of [
    join(homeDirectory, "dev"),
    join(homeDirectory, "Developer"),
    join(homeDirectory, "Projects"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(currentDirectory);
}

function expandHome(value: string, homeDirectory = homedir()): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return join(homeDirectory, value.slice(2));
  return value;
}

async function promptForSourceRoot(
  suggestedRoot: string,
  additionalRootCount: number,
): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const existingSuffix = additionalRootCount > 0
      ? ` + ${additionalRootCount} more existing ${additionalRootCount === 1 ? "root" : "roots"}`
      : "";
    const answer = await prompt.question(
      `Where do you keep your projects? [${suggestedRoot}${existingSuffix}] `,
    );
    return answer.trim();
  } finally {
    prompt.close();
  }
}

/** What settings already record about project roots, for the rerun guard. */
export type ExistingSourceRootState = {
  /** `discovery.workspaceRoots` — seeded on read, so never reliably empty. */
  roots: string[];
  /** `onboarding.sourceRootsAnsweredAt` — null until the operator answers. */
  answeredAt: number | null;
};

export async function resolveSetupSourceRoots(
  context: Pick<ScoutCommandContext, "isTty" | "output">,
  currentDirectory: string,
  sourceRoots: string[],
  existing: ExistingSourceRootState,
  ask: SourceRootPrompt = promptForSourceRoot,
): Promise<string[]> {
  if (sourceRoots.length > 0 || !context.isTty || context.output.mode === "json") {
    return sourceRoots;
  }
  // Guard on the answer, not on the array. `discovery.workspaceRoots` is seeded
  // with a plausible default whenever it reads back empty, so a non-empty array
  // proves nothing about whether the operator was ever asked — gating on it made
  // this prompt unreachable on any machine that had ever written settings.
  if (existing.answeredAt !== null) return [];

  const suggestedRoot = existing.roots[0] ?? suggestProjectSourceRoot(currentDirectory);
  const selectedRoot = (await ask(suggestedRoot, Math.max(0, existing.roots.length - 1))).trim();
  // Legacy/migrated settings can contain several curated roots without the
  // newer answer timestamp. Accepting the displayed default means "keep what
  // I have", not "replace the list with only its first display value".
  if (!selectedRoot && existing.roots.length > 0) return existing.roots;
  // Resolve against the setup context directory, not process.cwd(), so a
  // relative answer means the same thing under OPENSCOUT_SETUP_CWD.
  return [resolve(currentDirectory, expandHome(selectedRoot || suggestedRoot))];
}

export async function runSetupCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseSetupCommandOptions(args, defaultScoutContextDirectory(context));
  const settings = await readOpenScoutSettings({ currentDirectory: options.currentDirectory });
  const hasSavedSettings = existsSync(resolveOpenScoutSupportPaths().settingsPath);
  options.sourceRoots = await resolveSetupSourceRoots(
    // The prompt reads stdin, but context.isTty only describes stdout. Without
    // the stdin check, a piped stdin under a TTY stdout blocks on a question
    // nobody can answer.
    { ...context, isTty: context.isTty && Boolean(process.stdin.isTTY) },
    options.currentDirectory,
    options.sourceRoots,
    {
      roots: hasSavedSettings ? settings.discovery.workspaceRoots : [],
      answeredAt: hasSavedSettings ? settings.onboarding.sourceRootsAnsweredAt : null,
    },
  );
  const report = await runScoutSetup(options);
  context.output.writeValue(report, renderScoutSetupReport);
}
