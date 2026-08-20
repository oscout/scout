import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { createScoutOutput } from "../output.ts";
import { resolveSetupSourceRoots, suggestProjectSourceRoot } from "./setup.ts";

describe("interactive Scout setup", () => {
  const repoRoot = resolve(import.meta.dir, "../../../../..");
  const projectsRoot = resolve(repoRoot, "..");

  test("suggests the parent of the current repository", () => {
    expect(suggestProjectSourceRoot(import.meta.dir)).toBe(projectsRoot);
  });

  test("asks for a project root only for an interactive setup without one", async () => {
    const asked: string[] = [];
    const roots = await resolveSetupSourceRoots(
      { isTty: true, output: createScoutOutput("plain", () => {}) },
      repoRoot,
      [],
      { roots: [], answeredAt: null },
      async (suggestedRoot) => {
        asked.push(suggestedRoot);
        return "~/Projects";
      },
    );

    expect(asked).toEqual([projectsRoot]);
    expect(roots).toEqual([`${homedir()}/Projects`]);
  });

  test("still asks when settings carry seeded roots the operator never answered for", async () => {
    // discovery.workspaceRoots is seeded on read, so it is never reliably
    // empty. Gating the prompt on it made the prompt unreachable on any machine
    // that had ever written settings — the headline `scout setup` question.
    const asked: string[] = [];
    const roots = await resolveSetupSourceRoots(
      { isTty: true, output: createScoutOutput("plain", () => {}) },
      "/workspace",
      [],
      { roots: ["/seeded/dev"], answeredAt: null },
      async (suggestedRoot) => {
        asked.push(suggestedRoot);
        return "";
      },
    );

    // The seeded root is the honest default: it is what the machine already
    // uses, so pressing Enter confirms rather than silently changes it.
    expect(asked).toEqual(["/seeded/dev"]);
    expect(roots).toEqual(["/seeded/dev"]);
  });

  test("default acceptance preserves every legacy root when the answer timestamp is absent", async () => {
    const prompts: Array<[string, number]> = [];
    const roots = await resolveSetupSourceRoots(
      { isTty: true, output: createScoutOutput("plain", () => {}) },
      "/workspace",
      [],
      { roots: ["/projects", "/oss"], answeredAt: null },
      async (suggestedRoot, additionalRootCount) => {
        prompts.push([suggestedRoot, additionalRootCount]);
        return "";
      },
    );

    expect(prompts).toEqual([["/projects", 1]]);
    expect(roots).toEqual(["/projects", "/oss"]);
  });

  test("resolves a relative answer against the setup directory, not process.cwd()", async () => {
    const roots = await resolveSetupSourceRoots(
      { isTty: true, output: createScoutOutput("plain", () => {}) },
      "/workspace",
      [],
      { roots: [], answeredAt: null },
      async () => "code",
    );

    expect(roots).toEqual(["/workspace/code"]);
  });

  test("preserves explicit and non-interactive roots without prompting", async () => {
    let prompts = 0;
    const ask = async () => {
      prompts += 1;
      return "/unexpected";
    };

    expect(await resolveSetupSourceRoots(
      { isTty: true, output: createScoutOutput("plain", () => {}) },
      "/workspace",
      ["/projects"],
      { roots: ["/existing"], answeredAt: 1 },
      ask,
    )).toEqual(["/projects"]);
    expect(await resolveSetupSourceRoots(
      { isTty: false, output: createScoutOutput("plain", () => {}) },
      "/workspace",
      [],
      { roots: [], answeredAt: null },
      ask,
    )).toEqual([]);
    expect(prompts).toBe(0);
  });

  test("preserves existing project roots on an interactive setup rerun", async () => {
    let prompts = 0;
    const roots = await resolveSetupSourceRoots(
      { isTty: true, output: createScoutOutput("plain", () => {}) },
      "/workspace",
      [],
      { roots: ["/projects", "/oss"], answeredAt: 1_700_000_000_000 },
      async () => {
        prompts += 1;
        return "/unexpected";
      },
    );

    expect(roots).toEqual([]);
    expect(prompts).toBe(0);
  });
});
