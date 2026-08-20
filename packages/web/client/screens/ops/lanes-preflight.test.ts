import { describe, expect, it } from "bun:test";

import {
  buildLanePreflightDeck,
  preflightCellTitle,
  preflightSessionLabel,
  PREFLIGHT_BLIND_CELLS,
} from "./lanes-preflight.ts";
import type { TailDiscoverySnapshot, TailDiscoveredTranscript } from "../../lib/types.ts";

const NOW = 1_700_000_000_000;
const WINDOW_MS = 5 * 60_000;

function transcript(overrides: Partial<TailDiscoveredTranscript> = {}): TailDiscoveredTranscript {
  return {
    source: "claude",
    transcriptPath: `/tmp/${overrides.sessionId ?? "session"}.jsonl`,
    sessionId: "019fae90-2cb7-7000-8000-000000000001",
    cwd: "/Users/dev/openscout",
    project: "openscout",
    harness: "scout-managed",
    mtimeMs: NOW - 1_000,
    size: 4_096,
    ...overrides,
  };
}

function snapshot(transcripts: TailDiscoveredTranscript[]): TailDiscoverySnapshot {
  return {
    generatedAt: NOW,
    processes: [],
    transcripts,
    totals: {
      total: transcripts.length,
      scoutManaged: transcripts.length,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: transcripts.length,
    },
  };
}

describe("lane pre-flight deck", () => {
  it("draws a small anonymous deck while discovery is still in flight", () => {
    const deck = buildLanePreflightDeck({
      discovery: null,
      discoveryPhase: "loading",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.identified).toBe(false);
    expect(deck.cells).toEqual([]);
    expect(deck.blindCells).toBe(PREFLIGHT_BLIND_CELLS);
  });

  it("takes count and identity from transcripts active inside the horizon", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([
        transcript({ sessionId: "aaa", mtimeMs: NOW - 2_000, project: "openscout" }),
        transcript({ sessionId: "bbb", source: "codex", mtimeMs: NOW - 30_000, project: "hudson" }),
        // Quiet far longer than the horizon: no lane will be built for it, so
        // no cell should promise one.
        transcript({ sessionId: "ccc", mtimeMs: NOW - 60 * 60_000 }),
      ]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.identified).toBe(true);
    expect(deck.blindCells).toBe(0);
    expect(deck.cells.map((cell) => cell.key)).toEqual(["aaa", "bbb"]);
    expect(deck.cells[1].source).toBe("codex");
    expect(deck.cells[1].project).toBe("hudson");
  });

  it("orders cells by most recent activity", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([
        transcript({ sessionId: "older", mtimeMs: NOW - 90_000 }),
        transcript({ sessionId: "newest", mtimeMs: NOW - 500 }),
        transcript({ sessionId: "middle", mtimeMs: NOW - 20_000 }),
      ]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.cells.map((cell) => cell.key)).toEqual(["newest", "middle", "older"]);
  });

  it("prefers lastEventAt over file mtime when the scan parsed one", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([
        // Touched recently, but its newest parseable event is outside the window.
        transcript({ sessionId: "stale-events", mtimeMs: NOW - 1_000, lastEventAt: NOW - 60 * 60_000 }),
        transcript({ sessionId: "live", mtimeMs: NOW - 120_000, lastEventAt: NOW - 4_000 }),
      ]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.cells.map((cell) => cell.key)).toEqual(["live"]);
    expect(deck.cells[0].lastActiveAt).toBe(NOW - 4_000);
  });

  it("collapses duplicate transcript paths for the same session", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([
        transcript({ sessionId: "dupe", transcriptPath: "/a.jsonl", mtimeMs: NOW - 1_000 }),
        transcript({ sessionId: "dupe", transcriptPath: "/b.jsonl", mtimeMs: NOW - 2_000 }),
      ]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.cells).toHaveLength(1);
  });

  it("falls back to the transcript path when a session has no id", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([
        transcript({ sessionId: null, transcriptPath: "/anon.jsonl", mtimeMs: NOW - 1_000 }),
      ]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.cells[0].key).toBe("/anon.jsonl");
    expect(deck.cells[0].sessionLabel).toBeNull();
    expect(preflightCellTitle(deck.cells[0])).toBe("claude");
  });

  it("caps the deck so a busy machine cannot carpet it", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      transcript({ sessionId: `s-${index}`, mtimeMs: NOW - index * 100 }));
    const deck = buildLanePreflightDeck({
      discovery: snapshot(many),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
      max: 12,
    });
    expect(deck.cells).toHaveLength(12);
    expect(deck.cells[0].key).toBe("s-0");
  });

  it("draws nothing when discovery resolves with no recent sessions", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([transcript({ sessionId: "old", mtimeMs: NOW - 24 * 60 * 60_000 })]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.identified).toBe(true);
    expect(deck.cells).toEqual([]);
    expect(deck.blindCells).toBe(0);
  });

  it("stops promising cells once discovery has failed", () => {
    const deck = buildLanePreflightDeck({
      discovery: null,
      discoveryPhase: "error",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.identified).toBe(true);
    expect(deck.cells).toEqual([]);
    expect(deck.blindCells).toBe(0);
  });

  it("tolerates a snapshot without a transcripts array", () => {
    const deck = buildLanePreflightDeck({
      discovery: { generatedAt: NOW, processes: [], totals: { total: 0, scoutManaged: 0, hudsonManaged: 0, unattributed: 0 } },
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.cells).toEqual([]);
  });

  it("keeps session labels long enough to survive same-millisecond UUIDv7 ids", () => {
    const a = preflightSessionLabel("019fae90-2cb7-7000-8000-000000000001");
    const b = preflightSessionLabel("019fae90-3e26-7000-8000-000000000002");
    expect(a).not.toBe(b);
    expect(a).toBe("019fae90-2cb7");
  });

  it("pre-draws only what a scoped embed will show", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([
        transcript({ sessionId: "here", project: "openscout" }),
        transcript({ sessionId: "elsewhere", project: "other-repo", cwd: "/Users/dev/other-repo" }),
      ]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
      matchTranscript: (candidate) => candidate.project === "openscout",
    });
    expect(deck.cells.map((cell) => cell.key)).toEqual(["here"]);
  });

  it("applies embed scoping before the cap, not after", () => {
    const wanted = Array.from({ length: 4 }, (_, index) =>
      transcript({ sessionId: `keep-${index}`, project: "openscout", mtimeMs: NOW - 900 - index }));
    const noise = Array.from({ length: 20 }, (_, index) =>
      transcript({ sessionId: `drop-${index}`, project: "other-repo", mtimeMs: NOW - 100 - index }));
    const deck = buildLanePreflightDeck({
      // Noise is more recent, so a cap applied before scoping would eat every
      // cell the embed actually wants.
      discovery: snapshot([...noise, ...wanted]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
      max: 12,
      matchTranscript: (candidate) => candidate.project === "openscout",
    });
    expect(deck.cells).toHaveLength(4);
    expect(deck.cells.every((cell) => cell.project === "openscout")).toBe(true);
  });

  it("treats clock skew from the future as active rather than stale", () => {
    const deck = buildLanePreflightDeck({
      discovery: snapshot([transcript({ sessionId: "ahead", mtimeMs: NOW + 5_000 })]),
      discoveryPhase: "ready",
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(deck.cells.map((cell) => cell.key)).toEqual(["ahead"]);
  });
});
