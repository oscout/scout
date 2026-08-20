import { describe, expect, test } from "bun:test";

import { loadRepoPullRequests, type RepoPullRequestLoadDeps } from "./repo-diff.ts";

function pullRequest(number: number, repo: string) {
  return JSON.stringify([{
    number,
    title: `${repo} pull request`,
    url: `https://github.com/${repo}/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    headRefName: `feature-${number}`,
    baseRefName: "main",
    author: { login: "scout" },
    updatedAt: "2026-07-28T12:00:00Z",
  }]);
}

describe("repo pull requests", () => {
  test("runs gh once per remote or common Git directory", async () => {
    const ghCalls: Array<{
      cwd: string | undefined;
      timeoutMs: number;
      maxStdoutBytes: number | undefined;
      maxStderrBytes: number | undefined;
    }> = [];
    const commonDirCalls: string[] = [];
    const paths = [
      "/repos/alpha",
      "/repos/alpha-feature",
      "/repos/local",
      "/repos/local-feature",
    ];
    const deps: RepoPullRequestLoadDeps = {
      gitRemoteGetUrlOrigin: async (path) => path.includes("alpha")
        ? "git@github.com:owner/alpha.git"
        : null,
      gitCommonDir: async (path) => {
        commonDirCalls.push(path);
        return "/repos/local/.git";
      },
      execSystemFile: async (_file, _args, options) => {
        ghCalls.push({
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          maxStdoutBytes: options.maxStdoutBytes,
          maxStderrBytes: options.maxStderrBytes,
        });
        const isAlpha = options.cwd === "/repos/alpha";
        return {
          stdout: pullRequest(isAlpha ? 12 : 34, isAlpha ? "owner/alpha" : "local"),
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const snapshot = await loadRepoPullRequests({ paths, limitPerRepo: 8 }, deps);

    expect(ghCalls).toEqual([
      {
        cwd: "/repos/alpha",
        timeoutMs: 2_500,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 128 * 1024,
      },
      {
        cwd: "/repos/local",
        timeoutMs: 2_500,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 128 * 1024,
      },
    ]);
    expect(commonDirCalls).toEqual(["/repos/local", "/repos/local-feature"]);
    expect(snapshot.paths).toEqual(paths);
    expect(snapshot.pullRequests.map((item) => ({ id: item.id, path: item.path }))).toEqual([
      { id: "local#34", path: "/repos/local" },
      { id: "owner/alpha#12", path: "/repos/alpha" },
    ]);
    expect(snapshot.warnings).toEqual([]);
  });

  test("reports one gh failure for sibling worktrees", async () => {
    let ghCalls = 0;
    const snapshot = await loadRepoPullRequests({
      paths: ["/repos/alpha", "/repos/alpha-feature"],
      limitPerRepo: 8,
    }, {
      gitRemoteGetUrlOrigin: async () => "https://github.com/owner/alpha.git",
      gitCommonDir: async () => null,
      execSystemFile: async () => {
        ghCalls += 1;
        throw new Error("gh unavailable");
      },
    });

    expect(ghCalls).toBe(1);
    expect(snapshot.pullRequests).toEqual([]);
    expect(snapshot.warnings).toEqual(["owner/alpha: open PRs unavailable"]);
  });
});
