import { describe, expect, test } from "bun:test";

import type { CodexDeckThreadSnapshot } from "../../surface-contract/scout-surface-contract.ts";
import {
  discoverPreferredDeckLane,
  prioritizeDeckLane,
  type DiscoverableDeckLane,
} from "./deck-lane-discovery.ts";

const host = { id: "web:air", name: "Air", state: "connected" as const };

function lane(id: string, transport = "codex_app_server"): DiscoverableDeckLane {
  return {
    id,
    key: `${host.id}:${id}`,
    hostId: host.id,
    transport,
  };
}

function snapshot(agentId: string, state: "running" | "idle" | "disconnected"): CodexDeckThreadSnapshot {
  return {
    adapter: "codex_app_server",
    agentId,
    threadId: state === "disconnected" ? null : `thread-${agentId}`,
    turnId: state === "running" ? `turn-${agentId}` : null,
    state,
    capabilities: { connect: true, start: true, steer: true, interrupt: true, queue: false, approvals: false },
    capabilityNotes: { queue: "No queue.", approvals: "Runtime-owned." },
    snapshot: null,
  };
}

describe("Scout Deck lane discovery", () => {
  test("prefers a genuinely running Scout-managed Codex session and promotes it", async () => {
    const lanes = [lane("cold"), lane("running"), lane("view-only", "tmux")];
    const preferred = await discoverPreferredDeckLane(lanes, async (route) => {
      if (route.agentId === "cold") throw new Error("No open task");
      return snapshot(route.agentId, "running");
    });
    expect(preferred).toBe(`${host.id}:running`);
    expect(prioritizeDeckLane(lanes, preferred!).map((item) => item.id)).toEqual([
      "running",
      "cold",
      "view-only",
    ]);
  });
});
