import { describe, expect, test } from "bun:test";

import {
  preferredHopSurface,
  resolveSessionTerminalSurface,
  sessionRefCandidates,
} from "./terminal-session-resolve.js";
import type {
  TerminalSessionRecord,
  TerminalSurface,
} from "./terminal-sessions.js";

function surface(overrides: Partial<TerminalSurface> = {}): TerminalSurface {
  return {
    backend: "tmux",
    sessionName: "session-abc123",
    paneId: null,
    attachCommand: ["tmux", "attach", "-t", "session-abc123"],
    observeCommand: null,
    relay: { backend: "tmux", sessionName: "session-abc123" },
    state: "live",
    ...overrides,
  };
}

function record(overrides: Partial<TerminalSessionRecord> = {}): TerminalSessionRecord {
  return {
    id: "term-1",
    harness: "claude",
    sourceSessionId: "claude-session-1",
    cwd: "/repo",
    resumeCommand: "claude --resume claude-session-1",
    surfaces: [surface()],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("sessionRefCandidates", () => {
  test("cleans transcript paths and jsonl leaves", () => {
    expect(sessionRefCandidates("/Users/x/.claude/projects/p/abc123.jsonl")).toEqual(["abc123"]);
    expect(sessionRefCandidates("  abc123  ")).toEqual(["abc123"]);
    expect(sessionRefCandidates("")).toEqual([]);
    expect(sessionRefCandidates(null)).toEqual([]);
  });

  test("adds the suffix of a namespace-scoped ref", () => {
    expect(sessionRefCandidates("session:claude:abc123")).toEqual(
      expect.arrayContaining(["session:claude:abc123", "claude:abc123", "abc123"]),
    );
    expect(sessionRefCandidates("claude:abc123")).toEqual(
      expect.arrayContaining(["claude:abc123", "abc123"]),
    );
  });
});

describe("resolveSessionTerminalSurface", () => {
  test("binds a registered record by sourceSessionId", () => {
    const sessions = [record()];
    const hit = resolveSessionTerminalSurface(sessions, { sessionRefs: ["claude-session-1"] });
    expect(hit?.session.id).toBe("term-1");
    expect(hit?.via).toBe("sourceSessionId");
  });

  test("binds a registered record by a metadata ref", () => {
    const sessions = [record({
      sourceSessionId: "unrelated",
      metadata: { threadId: "thread-9" },
    })];
    const hit = resolveSessionTerminalSurface(sessions, { sessionRefs: ["thread-9"] });
    expect(hit?.via).toBe("metadata");
  });

  test("binds a discovered session by surface sessionName", () => {
    const sessions = [record({
      id: "discovered.srf1.x",
      origin: "discovered",
      harness: "",
      sourceSessionId: "session-abc123",
      surfaces: [surface({ sessionName: "session-abc123" })],
    })];
    const hit = resolveSessionTerminalSurface(sessions, { sessionRefs: ["session-abc123"] });
    expect(hit?.via).toBe("sessionName");
  });

  test("matches a namespace-scoped ref against the bare session name", () => {
    const sessions = [record({
      origin: "discovered",
      surfaces: [surface({ sessionName: "session-ms0hf3f7-3ngln1" })],
    })];
    const hit = resolveSessionTerminalSurface(sessions, {
      sessionRefs: ["tmux:session-ms0hf3f7-3ngln1"],
    });
    expect(hit?.surface.sessionName).toBe("session-ms0hf3f7-3ngln1");
  });

  test("registered sourceSessionId wins over a discovered sessionName match", () => {
    const sessions = [
      record({ origin: "discovered", surfaces: [surface({ sessionName: "claude-session-1" })] }),
      record({ id: "term-registered" }),
    ];
    const hit = resolveSessionTerminalSurface(sessions, { sessionRefs: ["claude-session-1"] });
    expect(hit?.session.id).toBe("term-registered");
    expect(hit?.via).toBe("sourceSessionId");
  });

  test("returns null when nothing provably matches", () => {
    expect(resolveSessionTerminalSurface([record()], { sessionRefs: ["nope"] })).toBeNull();
    expect(resolveSessionTerminalSurface([record()], { sessionRefs: [] })).toBeNull();
    expect(resolveSessionTerminalSurface([], { sessionRefs: ["x"] })).toBeNull();
  });
});

describe("preferredHopSurface", () => {
  test("prefers a live session-level surface over pane-scoped ones", () => {
    const session = record({
      surfaces: [
        surface({ paneId: "pane-1", state: "live" }),
        surface({ paneId: null, state: "detached" }),
      ],
    });
    expect(preferredHopSurface(session)?.paneId).toBeNull();
  });

  test("falls back to a live pane surface when no session-level surface exists", () => {
    const session = record({
      surfaces: [
        surface({ paneId: "pane-1", state: "exited" }),
        surface({ paneId: "pane-2", state: "live" }),
      ],
    });
    expect(preferredHopSurface(session)?.paneId).toBe("pane-2");
  });
});


test("qualified route refs resolve the native session and exited surfaces cannot win", () => {
  const stale = record({ id: "stale", surfaces: [surface({ state: "exited" })] });
  const live = record({ id: "current" });
  expect(resolveSessionTerminalSurface([stale, live], {
    sessionRefs: ["session:claude:claude-session-1"],
  })?.session.id).toBe("current");
  expect(resolveSessionTerminalSurface([stale], { sessionRefs: ["claude-session-1"] })).toBeNull();
  expect(resolveSessionTerminalSurface([stale], { sessionRefs: ["session-abc123"] })).toBeNull();
  expect(preferredHopSurface(stale)).toBeNull();
});

test("qualified harness scope cannot select another harness or an unknown discovered source", () => {
  const codex = record({ id: "codex", harness: "codex", sourceSessionId: "shared" });
  const claude = record({ id: "claude", harness: "claude", sourceSessionId: "shared" });
  expect(resolveSessionTerminalSurface([codex, claude], { sessionRefs: ["session:claude:shared"] })?.session.id).toBe("claude");
  expect(resolveSessionTerminalSurface([codex], { sessionRefs: ["claude:shared"] })).toBeNull();
  const discovered = record({ id: "unknown", origin: "discovered", harness: "", surfaces: [surface({ sessionName: "shared" })] });
  expect(resolveSessionTerminalSurface([discovered], { sessionRefs: ["session:claude:shared"] })).toBeNull();
  expect(resolveSessionTerminalSurface([discovered], { sessionRefs: ["shared"] })?.session.id).toBe("unknown");
  expect(resolveSessionTerminalSurface([claude, codex], { sessionRefs: ["session:claude:shared", "session:codex:shared"] })).toBeNull();
});

test("ambiguous matches fail closed at each priority instead of using inventory order", () => {
  const one = record({ id: "one" });
  const two = record({ id: "two" });
  for (const records of [[one, two], [two, one]]) {
    expect(resolveSessionTerminalSurface(records, { sessionRefs: ["claude-session-1"] })).toBeNull();
    expect(resolveSessionTerminalSurface(records.map((r) => ({ ...r, sourceSessionId: "other", metadata: { threadId: "shared" } })), { sessionRefs: ["shared"] })).toBeNull();
    expect(resolveSessionTerminalSurface(records.map((r) => ({ ...r, origin: "discovered" as const })), { sessionRefs: ["session-abc123"] })).toBeNull();
  }
  expect(resolveSessionTerminalSurface([one], { sessionRefs: ["claude-session-1"] })?.session.id).toBe("one");
});
