import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentWorkspace, SCOUT_WORKSPACES_DIRNAME } from "./agent-workspace.js";

const tempRoots: string[] = [];

function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-ws-"));
  tempRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  return root;
}

function makeNonGitDir(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-nongit-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("createAgentWorkspace", () => {
  test("creates a git worktree under .scout-worktrees on branch scout/<agent>", async () => {
    const root = makeGitRepo();
    const result = await createAgentWorkspace(root, "explorer");

    expect(result).not.toBeNull();
    expect(result!.path).toBe(join(root, SCOUT_WORKSPACES_DIRNAME, "explorer"));
    expect(result!.branch).toBe("scout/explorer");
    expect(statSync(result!.path).isDirectory()).toBe(true);

    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: result!.path,
    }).toString().trim();
    expect(head).toBe("scout/explorer");
  });

  test("honors a requested branch name", async () => {
    const root = makeGitRepo();
    const result = await createAgentWorkspace(root, "explorer", "feature/thing");

    expect(result!.branch).toBe("feature/thing");
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: result!.path,
    }).toString().trim();
    expect(head).toBe("feature/thing");
  });

  test("rejects option-like requested branch names before git worktree add", async () => {
    const root = makeGitRepo();

    await expect(createAgentWorkspace(root, "explorer", "--orphan=/tmp/x")).rejects.toThrow("must not start with '-'");
    expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME, "explorer"))).toBe(false);
  });

  test("reuses an existing workspace at the same path", async () => {
    const root = makeGitRepo();
    const first = await createAgentWorkspace(root, "explorer");
    const second = await createAgentWorkspace(root, "explorer");

    expect(second).not.toBeNull();
    expect(second!.path).toBe(first!.path);
    expect(second!.branch).toBe("scout/explorer");
  });

  test("returns null when the project is not a git repo", async () => {
    const root = makeNonGitDir();
    const result = await createAgentWorkspace(root, "explorer");

    expect(result).toBeNull();
    expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME))).toBe(false);
  });
});
