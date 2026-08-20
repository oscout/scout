import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getRepoWatchSnapshot,
  parseGitStatusPorcelainV2,
  parseGitWorktreeList,
  repoWatchHintsFromBrokerSnapshot,
  repoWatchHintsFromTailDiscovery,
} from "./repo-watch/index.ts";

let tempRoot = "";
const originalRepoWatchRoots = process.env.OPENSCOUT_REPO_WATCH_ROOTS;
const originalRepoWatchNative = process.env.OPENSCOUT_REPO_WATCH_NATIVE;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fakeGitFromCommands(handler: (cwd: string, command: string) => string | null | Promise<string | null>) {
  return {
    revParse(input: { repoRoot: string; kind: string; ref?: string; quiet?: boolean }) {
      const command = input.kind === "showToplevel"
        ? "rev-parse --show-toplevel"
        : input.kind === "gitCommonDir"
          ? "rev-parse --git-common-dir"
          : input.kind === "verifyCommit"
            ? `rev-parse --verify ${input.quiet ? "--quiet " : ""}${input.ref}^{commit}`
            : `rev-parse ${input.kind}`;
      return handler(input.repoRoot, command);
    },
    statusPorcelain(input: { repoRoot: string; version: "v1" | "v2"; branch?: boolean; untrackedMode?: "normal" }) {
      const args = [`status --porcelain=${input.version}`];
      if (input.branch) args.push("--branch");
      if (input.untrackedMode === "normal") args.push("-unormal");
      return handler(input.repoRoot, args.join(" "));
    },
    mergeBase(input: { repoRoot: string; baseRef: string; compareRef: string }) {
      return handler(input.repoRoot, `merge-base ${input.baseRef} ${input.compareRef}`);
    },
    diffShortstat(input: { repoRoot: string; selector: { kind: string; baseRef?: string; compareRef?: string } }) {
      const command = input.selector.kind === "staged"
        ? "diff --cached --shortstat"
        : input.selector.kind === "range"
          ? `diff --shortstat ${input.selector.baseRef}..${input.selector.compareRef}`
          : "diff --shortstat";
      return handler(input.repoRoot, command);
    },
    logLastCommitUnix(repoRoot: string) {
      return handler(repoRoot, "log -1 --format=%ct");
    },
    worktreeListPorcelain(repoRoot: string) {
      return handler(repoRoot, "worktree list --porcelain");
    },
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "openscout-repo-watch-"));
  delete process.env.OPENSCOUT_REPO_WATCH_ROOTS;
  delete process.env.OPENSCOUT_REPO_WATCH_NATIVE;
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  if (originalRepoWatchRoots === undefined) delete process.env.OPENSCOUT_REPO_WATCH_ROOTS;
  else process.env.OPENSCOUT_REPO_WATCH_ROOTS = originalRepoWatchRoots;
  if (originalRepoWatchNative === undefined) delete process.env.OPENSCOUT_REPO_WATCH_NATIVE;
  else process.env.OPENSCOUT_REPO_WATCH_NATIVE = originalRepoWatchNative;
});

describe("repo-watch", () => {
  test("parses Git worktree porcelain output", () => {
    const parsed = parseGitWorktreeList([
      "worktree /Users/me/dev/openscout",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/me/dev/openscout-feature",
      "HEAD def456",
      "detached",
      "",
    ].join("\n"));

    expect(parsed).toEqual([
      {
        path: "/Users/me/dev/openscout",
        head: "abc123",
        branch: "main",
        detached: false,
        bare: false,
      },
      {
        path: "/Users/me/dev/openscout-feature",
        head: "def456",
        branch: null,
        detached: true,
        bare: false,
      },
    ]);
  });

  test("parses Git status porcelain v2 branch and dirty counts", () => {
    const parsed = parseGitStatusPorcelainV2([
      "# branch.oid abc123",
      "# branch.head feature/repo-watch",
      "# branch.upstream origin/feature/repo-watch",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 abc abc src/index.ts",
      "1 A. N... 000000 100644 100644 000 def src/new.ts",
      "? scratch.md",
      "u UU N... 100644 100644 100644 100644 a b c d conflicted.txt",
      "",
    ].join("\n"));

    expect(parsed.branch).toMatchObject({
      name: "feature/repo-watch",
      upstream: "origin/feature/repo-watch",
      ahead: 2,
      behind: 1,
      diverged: true,
    });
    expect(parsed.status.clean).toBe(false);
    expect(parsed.status.staged).toBe(1);
    expect(parsed.status.unstaged).toBe(1);
    expect(parsed.status.untracked).toBe(1);
    expect(parsed.status.conflicts).toBe(1);
  });

  test("builds a snapshot from a real Git repository", async () => {
    const repo = join(tempRoot, "demo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["-c", "user.email=scout@example.test", "-c", "user.name=Scout", "commit", "-m", "initial"]);
    writeFileSync(join(repo, "README.md"), "hello\nworld\n", "utf8");
    writeFileSync(join(repo, "scratch.md"), "scratch\n", "utf8");

    const snapshot = await getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      hints: [
        {
          path: repo,
          source: "endpoint",
          agentId: "agent.codex",
          agentName: "Codex",
          agentState: "active",
          sessionId: "session-1",
          harness: "codex",
        },
      ],
    });

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.totals).toMatchObject({
      projects: 1,
      worktrees: 1,
      dirtyWorktrees: 1,
      attachedAgents: 1,
      attachedSessions: 1,
    });
    const worktree = snapshot.projects[0]!.worktrees[0]!;
    expect(worktree.branch.name).toBe("main");
    expect(worktree.attention).toBe("attention");
    expect(worktree.attentionReasons).toContain("Dirty main");
    expect(worktree.status.unstaged).toBe(1);
    expect(worktree.status.untracked).toBe(1);
    expect(worktree.agents[0]?.id).toBe("agent.codex");
    expect(worktree.sessions[0]?.id).toBe("session-1");
  });

  test("decorates native repo-service scan output with Scout hints and attention", async () => {
    const repo = join(tempRoot, "native-demo");
    mkdirSync(repo, { recursive: true });
    const calls: string[] = [];

    const snapshot = await getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      hints: [
        {
          path: repo,
          source: "endpoint",
          agentId: "agent.codex",
          agentName: "Codex",
          agentState: "active",
          sessionId: "session-1",
          harness: "codex",
        },
      ],
      nativeScan: async (request) => {
        calls.push(JSON.stringify(request));
        expect(request.hints).toEqual([{
          path: repo,
          source: "endpoint",
          hintId: "agent.codex",
        }]);
        expect(request.limits.includeDiff).toBe(false);
        return {
          schema: "openscout.repo.scan/v1",
          generatedAt: 1_780_860_000_000,
          projects: [{
            root: repo,
            commonGitDir: join(repo, ".git"),
            worktrees: [{
              path: repo,
              name: "native-demo",
              isBare: false,
              branch: {
                name: "main",
                upstream: null,
                head: "abc123",
                detached: false,
                ahead: 0,
                behind: 0,
                isMain: true,
                diverged: false,
              },
              status: {
                clean: false,
                staged: 0,
                unstaged: 1,
                untracked: 0,
                conflicts: 0,
                changedFiles: 1,
                files: [{ path: "README.md", status: "unstaged" }],
              },
              diff: {
                branchShortstat: null,
                unstagedShortstat: null,
                stagedShortstat: null,
              },
              lastCommitAt: null,
              scannedAt: 1_780_860_000_000,
            }],
          }],
          diagnostics: [{
            level: "warning",
            kind: "max_worktrees",
            message: "native capped worktrees",
            path: repo,
          }],
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(snapshot.generatedAt).toBe(1_780_860_000_000);
    expect(snapshot.warnings).toEqual(["native capped worktrees"]);
    expect(snapshot.totals).toMatchObject({
      projects: 1,
      worktrees: 1,
      dirtyWorktrees: 1,
      attachedAgents: 1,
      attachedSessions: 1,
    });
    const worktree = snapshot.projects[0]!.worktrees[0]!;
    expect(worktree.attention).toBe("attention");
    expect(worktree.attentionReasons).toContain("Dirty main");
    expect(worktree.agents[0]?.id).toBe("agent.codex");
    expect(worktree.sessions[0]?.id).toBe("session-1");
  });

  test("surfaces native repo-service failures when native mode is enabled", async () => {
    const repo = join(tempRoot, "native-failure");
    mkdirSync(repo, { recursive: true });

    await expect(getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      hints: [{ path: repo, source: "endpoint", agentId: "agent.codex" }],
      nativeScan: async () => {
        throw new Error("native unavailable");
      },
    })).rejects.toThrow("native unavailable");
  });

  test("falls back when native repo-service hits its budget before returning repos", async () => {
    const repo = join(tempRoot, "native-budget");
    mkdirSync(repo, { recursive: true });
    const gitCalls: string[] = [];

    const snapshot = await getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      hints: [{ path: repo, source: "endpoint", agentId: "agent.codex" }],
      nativeScan: async () => ({
        schema: "openscout.repo.scan/v1",
        generatedAt: 1_780_860_000_000,
        projects: [],
        diagnostics: [{
          level: "warning",
          kind: "scan_budget",
          message: "Repo scan stopped after reaching the scan budget.",
          path: null,
        }],
      }),
      git: fakeGitFromCommands((_cwd, command) => {
        gitCalls.push(command);
        if (command === "rev-parse --show-toplevel") return `${repo}\n`;
        if (command === "rev-parse --git-common-dir") return ".git\n";
        if (command === "worktree list --porcelain") {
          return [
            `worktree ${repo}`,
            "HEAD abc123",
            "branch refs/heads/main",
            "",
          ].join("\n");
        }
        if (command === "status --porcelain=v2 --branch -unormal") {
          return [
            "# branch.oid abc123",
            "# branch.head main",
            "",
          ].join("\n");
        }
        return "";
      }),
    });

    expect(gitCalls).toContain("rev-parse --show-toplevel");
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]!.root).toBe(repo);
    expect(snapshot.warnings).toContain("Repo scan stopped after reaching the scan budget.");
    expect(snapshot.warnings).toContain(
      "Repo Watch fell back to the TypeScript scanner because the native repo service hit its budget before returning repositories.",
    );
  });

  test("native budget fallback prefers a fresh TypeScript scan over a smaller last snapshot", async () => {
    const firstRepo = join(tempRoot, "native-budget-a");
    const secondRepo = join(tempRoot, "native-budget-b");
    mkdirSync(firstRepo, { recursive: true });
    mkdirSync(secondRepo, { recursive: true });
    const hints = [
      { path: firstRepo, source: "endpoint" as const },
      { path: secondRepo, source: "endpoint" as const },
    ];
    const fakeGit = fakeGitFromCommands((cwd, command) => {
      if (command === "rev-parse --show-toplevel") return `${cwd}\n`;
      if (command === "rev-parse --git-common-dir") return ".git\n";
      if (command === "worktree list --porcelain") {
        return [
          `worktree ${cwd}`,
          "HEAD abc123",
          "branch refs/heads/main",
          "",
        ].join("\n");
      }
      if (command === "status --porcelain=v2 --branch -unormal") {
        return [
          "# branch.oid abc123",
          "# branch.head main",
          "",
        ].join("\n");
      }
      return "";
    });

    const smallerSnapshot = await getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      hints,
      maxRoots: 1,
      git: fakeGit,
    });
    expect(smallerSnapshot.projects).toHaveLength(1);

    const expandedSnapshot = await getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      hints,
      maxRoots: 2,
      nativeScan: async () => ({
        schema: "openscout.repo.scan/v1",
        generatedAt: 1_780_860_000_000,
        projects: [],
        diagnostics: [{
          level: "warning",
          kind: "scan_budget",
          message: "Repo scan stopped after reaching the scan budget.",
          path: null,
        }],
      }),
      git: fakeGit,
    });

    expect(expandedSnapshot.projects.map((project) => project.root).sort()).toEqual([
      firstRepo,
      secondRepo,
    ]);
  });

  test("deduplicates Git root probes for repeated path hints", async () => {
    const repo = join(tempRoot, "dedupe");
    mkdirSync(repo, { recursive: true });
    const calls: string[] = [];

    const snapshot = await getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      hints: [
        { path: repo, source: "endpoint", agentId: "agent.one" },
        { path: repo, source: "tail-transcript", sessionId: "session.one" },
      ],
      git: fakeGitFromCommands((_cwd, command) => {
        calls.push(command);
        if (command === "rev-parse --show-toplevel") return `${repo}\n`;
        if (command === "rev-parse --git-common-dir") return ".git\n";
        if (command === "worktree list --porcelain") {
          return [
            `worktree ${repo}`,
            "HEAD abc123",
            "branch refs/heads/feature",
            "",
          ].join("\n");
        }
        if (command === "status --porcelain=v2 --branch -unormal") {
          return [
            "# branch.oid abc123",
            "# branch.head feature",
            "",
          ].join("\n");
        }
        return "";
      }),
    });

    expect(calls.filter((call) => call === "rev-parse --show-toplevel")).toHaveLength(1);
    expect(calls).not.toContain("diff --shortstat");
    expect(calls).not.toContain("log -1 --format=%ct");
    expect(snapshot.totals.attachedAgents).toBe(1);
    expect(snapshot.totals.attachedSessions).toBe(1);
  });

  test("optionally enriches worktrees with diff and commit summaries", async () => {
    const repo = join(tempRoot, "enrichment");
    mkdirSync(repo, { recursive: true });

    const snapshot = await getRepoWatchSnapshot({
      force: true,
      cacheTtlMs: 0,
      includeDiff: true,
      includeLastCommit: true,
      hints: [{ path: repo, source: "environment" }],
      git: fakeGitFromCommands((_cwd, command) => {
        if (command === "rev-parse --show-toplevel") return `${repo}\n`;
        if (command === "rev-parse --git-common-dir") return ".git\n";
        if (command === "worktree list --porcelain") {
          return [
            `worktree ${repo}`,
            "HEAD abc123",
            "branch refs/heads/feature",
            "",
          ].join("\n");
        }
        if (command === "status --porcelain=v2 --branch -unormal") {
          return [
            "# branch.oid abc123",
            "# branch.head feature",
            "",
          ].join("\n");
        }
        if (command === "diff --shortstat") return " 1 file changed, 2 insertions(+)\n";
        if (command === "diff --cached --shortstat") return "";
        if (command === "rev-parse --verify --quiet origin/main^{commit}") return "base-ref\n";
        if (command === "merge-base origin/main HEAD") return "base-sha\n";
        if (command === "diff --shortstat base-sha..HEAD") return " 3 files changed, 10 insertions(+), 4 deletions(-)\n";
        if (command === "log -1 --format=%ct") return "1780460000\n";
        return "";
      }),
    });

    const worktree = snapshot.projects[0]!.worktrees[0]!;
    expect(worktree.diff.branchShortstat).toBe("3 files changed, 10 insertions(+), 4 deletions(-)");
    expect(worktree.diff.unstagedShortstat).toBe("1 file changed, 2 insertions(+)");
    expect(worktree.diff.stagedShortstat).toBeNull();
    expect(worktree.lastCommitAt).toBe(1_780_460_000_000);
  });

  test("does not reuse cached snapshots across enrichment options", async () => {
    const repo = join(tempRoot, "cache-shape");
    mkdirSync(repo, { recursive: true });
    const calls: string[] = [];

    const fakeGit = fakeGitFromCommands((_cwd, command) => {
      calls.push(command);
      if (command === "rev-parse --show-toplevel") return `${repo}\n`;
      if (command === "rev-parse --git-common-dir") return ".git\n";
      if (command === "worktree list --porcelain") {
        return [
          `worktree ${repo}`,
          "HEAD abc123",
          "branch refs/heads/feature",
          "",
        ].join("\n");
      }
      if (command === "status --porcelain=v2 --branch -unormal") {
        return [
          "# branch.oid abc123",
          "# branch.head feature",
          "",
        ].join("\n");
      }
      if (command === "diff --shortstat") return " 1 file changed, 3 insertions(+)\n";
      if (command === "diff --cached --shortstat") return "";
      if (command === "log -1 --format=%ct") return "1780460000\n";
      return "";
    });

    const baseOptions = {
      cacheTtlMs: 10_000,
      hints: [{ path: repo, source: "environment" as const }],
      git: fakeGit,
      now: () => 1_780_760_000_000,
    };

    const fastSnapshot = await getRepoWatchSnapshot({
      ...baseOptions,
      force: true,
    });
    expect(fastSnapshot.projects[0]!.worktrees[0]!.diff.unstagedShortstat).toBeNull();
    expect(fastSnapshot.projects[0]!.worktrees[0]!.lastCommitAt).toBeNull();

    calls.length = 0;
    const enrichedSnapshot = await getRepoWatchSnapshot({
      ...baseOptions,
      includeDiff: true,
      includeLastCommit: true,
    });
    const worktree = enrichedSnapshot.projects[0]!.worktrees[0]!;
    expect(worktree.diff.unstagedShortstat).toBe("1 file changed, 3 insertions(+)");
    expect(worktree.lastCommitAt).toBe(1_780_460_000_000);
    expect(calls).toContain("diff --shortstat");
    expect(calls).toContain("log -1 --format=%ct");
  });

  test("creates hints from broker and tail snapshots", () => {
    const brokerHints = repoWatchHintsFromBrokerSnapshot({
      agents: {
        "agent.one": {
          displayName: "One",
          metadata: { projectRoot: "/Users/example/project-one" },
        },
        "agent.loose": {
          displayName: "Loose",
          metadata: { projectRoot: "/Users/example/loose-project" },
        },
      },
      endpoints: {
        "endpoint.one": {
          id: "endpoint.one",
          agentId: "agent.one",
          projectRoot: "/Users/example/project-one",
          state: "active",
          sessionId: "session-one",
          harness: "codex",
        },
        "endpoint.offline": {
          id: "endpoint.offline",
          agentId: "agent.offline",
          projectRoot: "/Users/example/offline-project",
          state: "offline",
          sessionId: "session-offline",
          harness: "codex",
        },
      },
    });
    const tailHints = repoWatchHintsFromTailDiscovery({
      generatedAt: 1,
      processes: [{
        pid: 42,
        ppid: 1,
        command: "codex",
        etime: "00:01",
        cwd: "/tmp/project-two",
        harness: "unattributed",
        parentChain: [],
        source: "codex",
      }],
      transcripts: [{
        source: "claude",
        transcriptPath: "/tmp/transcript.jsonl",
        sessionId: "session-two",
        cwd: "/tmp/project-three",
        project: "project-three",
        harness: "scout-managed",
        mtimeMs: 1,
        size: 10,
      }],
      totals: {
        total: 1,
        scoutManaged: 1,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    });

    expect(brokerHints.map((hint) => hint.source)).toEqual(["endpoint", "agent"]);
    expect(brokerHints.map((hint) => hint.path)).not.toContain("/Users/example/offline-project");
    expect(tailHints.map((hint) => hint.source)).toEqual(["tail-process", "tail-transcript"]);
  });
});
