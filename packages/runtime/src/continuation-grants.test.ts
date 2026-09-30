import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuationAudit,
  claimContinuationActuation,
  DEFAULT_CONTINUATION_LEVEL,
  decideContinuation,
  loadContinuationPolicy,
  parseContinuationPolicy,
  resolveContinuationGrant,
} from "./continuation.js";

const pane = {
  herdrSession: "default",
  paneId: "w1:p2",
  terminalId: "term-p2",
  cwd: "/Users/art/dev/openscout",
  foregroundCwd: "/Users/art/dev/openscout/packages/web",
};

const BASH_PERMISSION = `
 Bash command

   bun test packages/web/server

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for this command
   3. No

 Esc to cancel · Tab to amend
`;

describe("continuation grants", () => {
  test("the default level continues nothing", () => {
    expect(DEFAULT_CONTINUATION_LEVEL).toBe("ask");
    expect(decideContinuation({ paneBody: BASH_PERMISSION }).act).toBe("notify");
  });

  test("no file, bad version, or junk is no grants", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-grants-"));
    expect(loadContinuationPolicy(join(dir, "missing.json")).grants).toEqual([]);
    writeFileSync(join(dir, "junk.json"), "{not json");
    expect(loadContinuationPolicy(join(dir, "junk.json")).grants).toEqual([]);
    expect(parseContinuationPolicy({ version: 2, grants: [{ scope: "project", path: "/x", level: "silent" }] }).grants)
      .toEqual([]);
    expect(parseContinuationPolicy({ version: 1, grants: [{ scope: "project", path: "/x", level: "yolo" }] }).grants)
      .toEqual([]);
    expect(parseContinuationPolicy({ version: 1 }).allowModel).toBe(false);
  });

  test("refuses root and relative project paths", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [
        { scope: "project", path: "/", level: "silent" },
        { scope: "project", path: "dev/openscout", level: "silent" },
      ],
    });
    expect(policy.grants).toEqual([]);
  });

  test("a pane with no grant is ask", () => {
    expect(resolveContinuationGrant(parseContinuationPolicy({ version: 1, grants: [] }), pane))
      .toEqual({ level: "ask", source: "default" });
  });

  test("a project grant applies only when every pane directory is inside it", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [{ scope: "project", path: "/Users/art/dev/openscout", level: "workspace" }],
    });
    expect(resolveContinuationGrant(policy, pane).level).toBe("workspace");
    expect(resolveContinuationGrant(policy, { ...pane, foregroundCwd: "/Users/art/dev/other" }).level).toBe("ask");
    // Sibling prefix is not inside.
    expect(resolveContinuationGrant(policy, {
      ...pane,
      cwd: "/Users/art/dev/openscout-worktrees/x",
      foregroundCwd: null,
    }).level).toBe("ask");
    expect(resolveContinuationGrant(policy, { ...pane, cwd: null, foregroundCwd: null }).level).toBe("ask");
  });

  test("the deepest project grant wins, and a session grant beats both", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [
        { scope: "project", path: "/Users/art/dev", level: "unattended" },
        { scope: "project", path: "/Users/art/dev/openscout", level: "ask" },
        { scope: "session", herdrSession: "other", paneId: "w1:p2", level: "silent" },
      ],
    });
    expect(resolveContinuationGrant(policy, pane).level).toBe("ask");
    expect(resolveContinuationGrant(policy, { ...pane, herdrSession: "other" })).toEqual({
      level: "silent",
      source: "session:other:w1:p2",
    });
  });

  test("a pane straddling a narrower ask grant is ask", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [
        { scope: "project", path: "/repo", level: "workspace" },
        { scope: "project", path: "/repo/sensitive", level: "ask" },
      ],
    });
    expect(resolveContinuationGrant(policy, {
      herdrSession: "s",
      paneId: "p",
      cwd: "/repo",
      foregroundCwd: "/repo/sensitive",
    }).level).toBe("ask");
    expect(resolveContinuationGrant(policy, {
      herdrSession: "s",
      paneId: "p",
      cwd: "/repo/src",
      foregroundCwd: "/repo",
    }).level).toBe("workspace");
  });

  test("a session grant does not leak to another session with the same pane id", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [{ scope: "session", herdrSession: "a", paneId: "w1:p2", level: "silent" }],
    });
    expect(resolveContinuationGrant(policy, { ...pane, herdrSession: "b", cwd: null, foregroundCwd: null }).level)
      .toBe("ask");
  });

  test("audit appends JSON lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-audit-"));
    const path = join(dir, "logs", "audit.jsonl");
    const entry = {
      at: 1,
      outcome: "attempt" as const,
      herdrSession: "default",
      paneId: "term-p2",
      level: "workspace" as const,
      grant: "project:/x",
      command: "bun test",
      risk: "workspace",
      keys: ["enter"],
      source: "rules" as const,
      reason: "workspace continues workspace",
    };
    appendContinuationAudit(entry, path);
    appendContinuationAudit({ ...entry, outcome: "sent" }, path);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.outcome)).toEqual(["attempt", "sent"]);
  });

  test("a claim is exclusive until it expires", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-claim-"));
    expect(claimContinuationActuation("default:term-p2:bun test", 30_000, dir)).toBe(true);
    expect(claimContinuationActuation("default:term-p2:bun test", 30_000, dir)).toBe(false);
    expect(claimContinuationActuation("default:term-p2:curl", 30_000, dir)).toBe(true);
    expect(claimContinuationActuation("short", 20, dir)).toBe(true);
    expect(claimContinuationActuation("short", 20, dir)).toBe(false);
    Bun.sleepSync(60);
    expect(claimContinuationActuation("short", 20, dir)).toBe(true);
  });

  test("simultaneous claims never both win, including across a bucket edge", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-claim-race-"));
    for (let round = 0; round < 50; round += 1) {
      const key = `race-${round}`;
      const wins = [claimContinuationActuation(key, 5, dir), claimContinuationActuation(key, 5, dir)];
      expect(wins.filter(Boolean).length).toBeLessThanOrEqual(1);
    }
  });
});
