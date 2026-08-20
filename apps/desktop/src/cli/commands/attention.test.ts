import { describe, expect, test } from "bun:test";

import {
  parseAttentionCommandOptions,
  renderAttentionCommandHelp,
  renderAttentionReport,
} from "./attention.ts";

describe("attention command help", () => {
  test("documents the on-demand report inputs", () => {
    const help = renderAttentionCommandHelp();

    expect(help).toContain("Usage: scout attention");
    expect(help).toContain("--since <time>");
    expect(help).toContain("--project <path>");
    expect(help).toContain("--no-git");
  });
});

describe("parseAttentionCommandOptions", () => {
  test("defaults to a two day report", () => {
    expect(parseAttentionCommandOptions([], {
      cwd: "/tmp/openscout",
      now: 200_000,
    })).toEqual({
      command: "report",
      since: 200_000 - 2 * 24 * 60 * 60 * 1000,
      limit: 8,
      projectRoots: [],
      includeGit: true,
      json: false,
    });
  });

  test("parses since, project filters, limit, and git toggle", () => {
    expect(parseAttentionCommandOptions([
      "--since",
      "12h",
      "--project",
      "packages/runtime",
      "--limit=3",
      "--no-git",
      "--json",
    ], {
      cwd: "/tmp/openscout",
      now: 200_000_000,
    })).toEqual({
      command: "report",
      since: 200_000_000 - 12 * 60 * 60 * 1000,
      limit: 3,
      projectRoots: ["/tmp/openscout/packages/runtime"],
      includeGit: false,
      json: true,
    });
  });
});

describe("renderAttentionReport", () => {
  test("renders ranked projects with evidence and next action", () => {
    const rendered = renderAttentionReport({
      generatedAt: 2_000_000,
      since: 1_000_000,
      brokerReachable: true,
      counts: {
        projects: 1,
        evidence: 1,
        gitProjects: 1,
        openCollaborationRecords: 0,
        activeFlights: 0,
        riskyTerminalFlights: 0,
        riskyMessages: 0,
      },
      projects: [
        {
          projectRoot: "/tmp/openscout",
          projectName: "openscout",
          status: "needs_attention",
          score: 50,
          lastActivityAt: 1_990_000,
          agents: ["openscout.codex"],
          reasons: ["dirty git worktree"],
          nextAction: "Review git status and diff.",
          git: {
            projectRoot: "/tmp/openscout",
            isGitRepo: true,
            branch: "codex/attention",
            upstream: "origin/codex/attention",
            ahead: 0,
            behind: 0,
            changedFiles: 2,
            stagedFiles: 1,
            unstagedFiles: 1,
            untrackedFiles: 0,
            hasChanges: true,
            lastCommitAt: 1_900_000,
            shortStatus: [],
            error: null,
          },
          evidence: [
            {
              kind: "git",
              severity: "interrupt",
              id: null,
              state: "codex/attention",
              summary: "branch codex/attention, 2 changed files",
              at: 1_900_000,
              agentId: null,
              invocationId: null,
              flightId: null,
              workId: null,
              messageId: null,
            },
          ],
        },
      ],
    });

    expect(rendered).toContain("Attention Report");
    expect(rendered).toContain("openscout");
    expect(rendered).toContain("dirty git worktree");
    expect(rendered).toContain("Review git status and diff.");
  });
});
