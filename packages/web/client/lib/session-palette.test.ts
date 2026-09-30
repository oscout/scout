import { describe, expect, test } from "bun:test";

import { sessionPaletteCommands } from "./session-palette.ts";
import type { Route, TailDiscoveredTranscript } from "./types.ts";

const NOW = 1_800_000_000_000;

function transcript(overrides: Partial<TailDiscoveredTranscript>): TailDiscoveredTranscript {
  return {
    source: "claude",
    transcriptPath: "/tmp/t.jsonl",
    sessionId: "c7cf2eb4-aaaa-bbbb-cccc-000000000000",
    cwd: "/Users/art/dev/openscout",
    project: "openscout",
    harness: "unattributed",
    lastEventAt: NOW - 6 * 60_000,
    mtimeMs: NOW - 6 * 60_000,
    size: 1,
    ...overrides,
  };
}

describe("sessionPaletteCommands", () => {
  test("labels a session by harness, short id, project and age, and jumps to it", () => {
    const routes: Route[] = [];
    const [command] = sessionPaletteCommands([transcript({})], (route) => routes.push(route), NOW);
    expect(command?.label).toBe("Go to session: claude c7cf2eb4 · openscout · 6m ago");
    command?.action();
    expect(routes).toEqual([{ view: "sessions", sessionId: "c7cf2eb4-aaaa-bbbb-cccc-000000000000" }]);
  });

  test("newest first; drops subagents, id-less, duplicate and stale transcripts", () => {
    const commands = sessionPaletteCommands([
      transcript({ sessionId: "old-00000", lastEventAt: NOW - 3 * 24 * 60 * 60_000 }),
      transcript({ sessionId: "older-000", lastEventAt: NOW - 60 * 60_000 }),
      transcript({ sessionId: "newer-000", lastEventAt: NOW - 60_000 }),
      transcript({ sessionId: "newer-000", lastEventAt: NOW - 30 * 60_000 }),
      transcript({ sessionId: "child-000", parentSessionId: "newer-000" }),
      transcript({ sessionId: "agent-000", subagentId: "agent-abc" }),
      transcript({ sessionId: null }),
    ], () => {}, NOW);
    expect(commands.map((command) => command.id)).toEqual([
      "session:open:newer-000",
      "session:open:older-000",
    ]);
  });
});
