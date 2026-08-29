import { describe, expect, test } from "bun:test";

import type { RepoPullRequestItem } from "./api.ts";
import {
  buildPullRequestMenuItems,
  defaultHarnessForLaunch,
  projectOptionsForPullRequest,
  pullRequestCheckoutCommand,
  pullRequestReviewPrompt,
  rankAgentsForPullRequest,
  type PullRequestReviewAgent,
} from "./pull-request-actions.ts";

function pr(overrides: Partial<RepoPullRequestItem> = {}): RepoPullRequestItem {
  return {
    id: "pr-1",
    repo: "arach/openscout",
    path: "/Users/art/dev/openscout",
    number: 412,
    title: "Polish repos PR actions",
    url: "https://github.com/oscout/scout/pull/412",
    state: "OPEN",
    isDraft: false,
    headRefName: "sco-088/anchored-l-polish",
    baseRefName: "main",
    author: "arach",
    updatedAt: "2026-07-21T12:00:00Z",
    ...overrides,
  };
}

function agent(overrides: Partial<PullRequestReviewAgent> = {}): PullRequestReviewAgent {
  return {
    id: "agent-other",
    name: "other",
    handle: "other",
    state: "available",
    projectRoot: "/Users/art/dev/other",
    cwd: "/Users/art/dev/other",
    project: "other",
    branch: "main",
    harness: "claude",
    model: null,
    harnessSessionId: null,
    retiredFromFleet: false,
    ...overrides,
  };
}

describe("pullRequestCheckoutCommand", () => {
  test("uses gh pr checkout", () => {
    expect(pullRequestCheckoutCommand(pr())).toBe("gh pr checkout 412");
  });
});

describe("pullRequestReviewPrompt", () => {
  test("includes title, url, and ship recommendation ask", () => {
    const prompt = pullRequestReviewPrompt(pr());
    expect(prompt).toContain("#412: Polish repos PR actions");
    expect(prompt).toContain("https://github.com/oscout/scout/pull/412");
    expect(prompt).toContain("Local path: /Users/art/dev/openscout");
    expect(prompt).toContain("ship / revise / hold");
  });
});

describe("rankAgentsForPullRequest", () => {
  test("prefers project-path matches, then drops retired agents", () => {
    const ranked = rankAgentsForPullRequest(pr(), [
      agent({ id: "far", handle: "far", projectRoot: "/tmp/far" }),
      agent({
        id: "same-path",
        handle: "reviewer",
        projectRoot: "/Users/art/dev/openscout",
        project: "openscout",
        branch: "sco-088/anchored-l-polish",
      }),
      agent({ id: "retired", handle: "gone", retiredFromFleet: true }),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["same-path", "far"]);
  });
});

describe("projectOptionsForPullRequest", () => {
  test("includes the PR path and additional repo-watch projects", () => {
    const options = projectOptionsForPullRequest(pr(), [
      { root: "/Users/art/dev/openscout", name: "openscout" },
      { root: "/Users/art/dev/other", name: "other" },
    ]);
    expect(options.map((item) => item.path)).toEqual([
      "/Users/art/dev/openscout",
      "/Users/art/dev/other",
    ]);
  });
});

describe("defaultHarnessForLaunch", () => {
  test("prefers the selected agent harness", () => {
    expect(defaultHarnessForLaunch(agent({ harness: "codex" }))).toBe("codex");
    expect(defaultHarnessForLaunch(null)).toBe("claude");
  });
});

describe("buildPullRequestMenuItems", () => {
  test("leads with assign for review and open on GitHub", () => {
    const labels = buildPullRequestMenuItems(pr(), {
      onBeginAssign: () => {},
    })
      .filter((item) => item.kind === "action")
      .map((item) => item.kind === "action" ? item.label : "");
    expect(labels[0]).toBe("Assign for review…");
    expect(labels[1]).toBe("Open on GitHub");
    expect(labels).toContain("Copy link");
    expect(labels).toContain("Copy checkout command");
  });

  test("adds worktree actions when a local match exists", () => {
    const labels = buildPullRequestMenuItems(pr(), {
      onBeginAssign: () => {},
      matchingWorktree: {
        id: "wt-1",
        path: "/Users/art/dev/openscout",
        branch: "sco-088/anchored-l-polish",
      },
      onSelectWorktreeId: () => {},
      onOpenDiff: () => {},
    })
      .filter((item) => item.kind === "action")
      .map((item) => item.kind === "action" ? item.label : "");
    expect(labels).toContain("Select worktree · sco-088/anchored-l-polish");
    expect(labels).toContain("Open local diff");
  });
});
