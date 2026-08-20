import { resolve } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { readScoutWebJson } from "../web-api.ts";

type DiffLayer = {
  kind: string;
  files: unknown[];
  shortstat?: string | null;
  rawPatch?: string | null;
};

type DiffSnapshot = {
  worktreePath: string;
  layers: DiffLayer[];
  scope?: {
    kind: "worktree" | "session";
    label: string;
    filteredPaths?: string[];
    touchedFiles?: number;
    changedFiles?: number;
  };
};

const DIFF_HELP = `scout diff — inspect local worktree or session-scoped diffs

Usage:
  scout diff worktree [path] [--file <path>] [--raw] [--json]
  scout diff session <session-id> [--all] [--raw] [--json]

Examples:
  scout diff worktree .
  scout diff worktree ~/dev/openscout --file apps/macos/Sources/Scout/ScoutRootView.swift --json
  scout diff session relay-openscout-card-t-39kmsa-codex --json`;

export async function runDiffCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "help" || action === "--help" || action === "-h") {
    context.output.writeText(DIFF_HELP);
    return;
  }
  switch (action) {
    case "worktree":
      await runWorktreeDiff(context, args.slice(1));
      return;
    case "session":
      await runSessionDiff(context, args.slice(1));
      return;
    default:
      throw new ScoutCliError(`unknown diff action: ${action} (try: scout diff worktree|session)`);
  }
}

async function runWorktreeDiff(context: ScoutCommandContext, args: string[]): Promise<void> {
  let targetPath: string | undefined;
  const files: string[] = [];
  let raw = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      context.output.writeText(DIFF_HELP);
      return;
    }
    if (arg === "--raw") {
      raw = true;
      continue;
    }
    if (arg === "--file") {
      const value = args[++index];
      if (!value) throw new ScoutCliError("--file needs a path");
      files.push(value);
      continue;
    }
    if (arg.startsWith("--file=")) {
      files.push(arg.slice("--file=".length));
      continue;
    }
    if (arg.startsWith("--")) throw new ScoutCliError(`unknown option for diff worktree: ${arg}`);
    if (targetPath) throw new ScoutCliError(`unexpected extra path: ${arg}`);
    targetPath = arg;
  }

  const worktreePath = resolve(context.cwd, targetPath ?? ".");
  const params = new URLSearchParams({ path: worktreePath });
  for (const file of files) params.append("file", file);
  const snapshot = await readScoutWebJson<DiffSnapshot>(context, `/api/repo-diff/worktree?${params.toString()}`);
  writeDiffOutput(context, snapshot, raw);
}

async function runSessionDiff(context: ScoutCommandContext, args: string[]): Promise<void> {
  let sessionId: string | undefined;
  let include: "changed" | "all" = "changed";
  let raw = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      context.output.writeText(DIFF_HELP);
      return;
    }
    if (arg === "--raw") {
      raw = true;
      continue;
    }
    if (arg === "--all" || arg === "--touched") {
      include = "all";
      continue;
    }
    if (arg === "--changed") {
      include = "changed";
      continue;
    }
    if (arg.startsWith("--")) throw new ScoutCliError(`unknown option for diff session: ${arg}`);
    if (sessionId) throw new ScoutCliError(`unexpected extra session id: ${arg}`);
    sessionId = arg;
  }
  if (!sessionId) throw new ScoutCliError("diff session needs a <session-id>");

  const params = new URLSearchParams({ sessionId, include });
  const snapshot = await readScoutWebJson<DiffSnapshot>(context, `/api/repo-diff/session?${params.toString()}`);
  writeDiffOutput(context, snapshot, raw);
}

function writeDiffOutput(context: ScoutCommandContext, snapshot: DiffSnapshot, raw: boolean): void {
  if (context.output.mode === "json") {
    context.output.writeValue(snapshot, renderDiffSummary);
    return;
  }
  if (raw) {
    context.output.writeText(snapshot.layers.map((layer) => layer.rawPatch ?? "").filter(Boolean).join("\n"));
    return;
  }
  context.output.writeText(renderDiffSummary(snapshot));
}

function renderDiffSummary(snapshot: DiffSnapshot): string {
  const scope = snapshot.scope;
  const lines = [
    `${scope?.label ?? "Diff"} — ${snapshot.worktreePath}`,
  ];
  if (scope?.kind === "session") {
    lines.push(`session files: ${scope.changedFiles ?? 0} changed / ${scope.touchedFiles ?? 0} touched`);
  }
  if (scope?.filteredPaths && scope.filteredPaths.length > 0) {
    lines.push(`filtered paths: ${scope.filteredPaths.length}`);
  }
  for (const layer of snapshot.layers) {
    lines.push(`${layer.kind}: ${layer.files.length} files${layer.shortstat ? ` · ${layer.shortstat}` : ""}`);
  }
  return lines.join("\n");
}
