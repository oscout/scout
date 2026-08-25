import { describe, expect, test } from "bun:test";

import type { ObservedActivity, ObservedStatusProjection } from "@openscout/protocol";
import {
  PRESENCE_GONE_AFTER_STALE_MS,
  PRESENCE_STALE_AFTER_MS,
  isPresenceBoundToConversation,
  presenceAgeMs,
  presenceLifecycle,
} from "@openscout/protocol";

import { ActivityTransitionTracker } from "./activity-transitions.js";
import { BrokerPresenceMap } from "./presence-map.js";

const T0 = 1_700_000_000_000;

function status(
  activity: ObservedActivity,
  updatedAt: number,
  detail?: string,
): ObservedStatusProjection {
  return {
    subjectKind: "agent",
    subjectId: "agent-1",
    agentId: "agent-1",
    phase: "running",
    activity,
    detail: detail ? { title: detail } : undefined,
    provenance: [],
    confidence: 0.9,
    updatedAt,
  };
}

describe("BrokerPresenceMap", () => {
  test("first observation is a transition", () => {
    const map = new BrokerPresenceMap();
    const result = map.observe({ status: status("thinking", T0) }, T0);

    expect(result?.transitioned).toBe(true);
    expect(result?.previousActivity).toBeUndefined();
    expect(result?.beat.activity).toBe("thinking");
    expect(result?.beat.transitionAt).toBe(T0);
  });

  test("unchanged activity bumps the map without a transition", () => {
    const map = new BrokerPresenceMap();
    map.observe({ status: status("executing", T0) }, T0);

    const later = T0 + 9 * 60_000;
    const result = map.observe({ status: status("executing", later) }, later);

    expect(result?.transitioned).toBe(false);
    // Nine minutes of heartbeats: the claim got fresher, the state did not
    // restart. Collapsing these two would erase time-in-state.
    expect(result?.beat.updatedAt).toBe(later);
    expect(result?.beat.transitionAt).toBe(T0);
    expect(presenceAgeMs(result!.beat, later)).toBe(9 * 60_000);
  });

  test("activity change is a transition and restarts time-in-state", () => {
    const map = new BrokerPresenceMap();
    map.observe({ status: status("executing", T0) }, T0);

    const later = T0 + 30_000;
    const result = map.observe({ status: status("blocked", later) }, later);

    expect(result?.transitioned).toBe(true);
    expect(result?.previousActivity).toBe("executing");
    expect(result?.beat.transitionAt).toBe(later);
  });

  test("detail churn inside the debounce does not transition", () => {
    const map = new BrokerPresenceMap({ detailDebounceMs: 5_000 });
    map.observe({ status: status("executing", T0, "running test 1") }, T0);

    const soon = T0 + 1_000;
    const churn = map.observe({ status: status("executing", soon, "running test 2") }, soon);
    expect(churn?.transitioned).toBe(false);
    expect(churn?.beat.detail).toBe("running test 2");

    const past = T0 + 20_000;
    const settled = map.observe({ status: status("executing", past, "running test 900") }, past);
    expect(settled?.transitioned).toBe(true);
  });

  test("presence is keyed per agent, not per room", () => {
    const map = new BrokerPresenceMap();
    map.observe({ status: status("working", T0), boundConversationId: "conv-1" }, T0);
    map.observe({ status: status("working", T0), boundConversationId: "conv-1" }, T0);

    expect(map.size()).toBe(1);
  });

  test("room gating is derived per room from one global beat", () => {
    const map = new BrokerPresenceMap();
    map.observe({
      status: status("executing", T0, "running the auth tests"),
      boundConversationId: "conv-1",
    }, T0);
    const beat = map.get("agent-1")!;

    // The room the work belongs to sees the detail; every other room sees bare
    // activity rather than a narration of work happening elsewhere.
    expect(isPresenceBoundToConversation(beat, "conv-1")).toBe(true);
    expect(isPresenceBoundToConversation(beat, "conv-2")).toBe(false);
  });

  test("staleAt is never earlier than the TTL from the last observation", () => {
    const map = new BrokerPresenceMap();
    const stalePastProjection: ObservedStatusProjection = {
      ...status("working", T0),
      staleAt: T0 - 1_000,
    };

    const result = map.observe({ status: stalePastProjection }, T0);
    expect(result?.beat.staleAt).toBe(T0 + PRESENCE_STALE_AFTER_MS);
  });

  test("a killed agent decays fresh to stale to gone with no cleanup event", () => {
    const map = new BrokerPresenceMap();
    map.observe({ status: status("executing", T0) }, T0);
    const beat = map.get("agent-1")!;

    expect(presenceLifecycle(beat, T0 + 30_000)).toBe("fresh");
    expect(presenceLifecycle(beat, T0 + PRESENCE_STALE_AFTER_MS + 1_000)).toBe("stale");

    const gone = T0 + PRESENCE_STALE_AFTER_MS + PRESENCE_GONE_AFTER_STALE_MS + 1;
    expect(presenceLifecycle(beat, gone)).toBe("gone");

    // Stale beats stay in the map: "observer went quiet, cannot yet tell if
    // dead" is the state the operator needs to see.
    expect(map.snapshot(T0 + PRESENCE_STALE_AFTER_MS + 1_000).beats).toHaveLength(1);
    expect(map.snapshot(gone).beats).toHaveLength(0);
  });

  test("transport-stale and activity=stalled are independent", () => {
    const map = new BrokerPresenceMap();
    const stalledNow = T0 + 120_000;
    map.observe({ status: status("stalled", stalledNow) }, stalledNow);
    const beat = map.get("agent-1")!;

    // Beats are arriving and inference says stuck: loud and fresh, not faded.
    expect(beat.activity).toBe("stalled");
    expect(presenceLifecycle(beat, stalledNow + 1_000)).toBe("fresh");
  });

  test("inferred stall is silence, not a stalled agent", () => {
    const map = new BrokerPresenceMap();
    map.observe({ status: status("executing", T0, "running swift test") }, T0);

    // The status projection turns a missing heartbeat into activity "stalled"
    // via staleness inference. Presence must not adopt it: that would render an
    // agent whose observer went quiet identically to one that is genuinely
    // stuck, which is the exact inversion the design forbids.
    const inferred: ObservedStatusProjection = {
      ...status("stalled", T0),
      provenance: [
        { source: "endpoint", refId: "endpoint-1", observedAt: T0, confidence: 0.82 },
        { source: "staleness_inference", refId: "endpoint-1", observedAt: T0 + 90_000, confidence: 0.58 },
      ],
    };

    expect(map.observe({ status: inferred }, T0 + 90_000)).toBeUndefined();

    // The last real activity is what decays, and it says what it last saw.
    const beat = map.get("agent-1")!;
    expect(beat.activity).toBe("executing");
    expect(beat.detail).toBe("running swift test");
    expect(presenceLifecycle(beat, T0 + 90_000)).toBe("stale");
  });

  test("an observed stall is kept — beats arriving, inference says stuck", () => {
    const map = new BrokerPresenceMap();
    map.observe({ status: status("executing", T0) }, T0);

    const later = T0 + 30_000;
    const result = map.observe({ status: status("stalled", later) }, later);

    expect(result?.transitioned).toBe(true);
    expect(result?.beat.activity).toBe("stalled");
    expect(presenceLifecycle(result!.beat, later)).toBe("fresh");
  });

  test("dead evidence never resurrects a gone agent", () => {
    const map = new BrokerPresenceMap();
    map.observe({ status: status("working", T0) }, T0);

    const wayLater = T0 + 10 * 60_000;
    // Same frozen observation, sampled again long after it decayed. Folding it
    // back in would republish the agent on every sample forever.
    expect(map.observe({ status: status("working", T0) }, wayLater)).toBeUndefined();
    expect(map.size()).toBe(0);
  });

  test("pruning forgets the transition entry too", () => {
    const transitions = new ActivityTransitionTracker();
    const map = new BrokerPresenceMap({ transitions });
    map.observe({ status: status("working", T0) }, T0);
    expect(transitions.size()).toBe(1);

    map.prune(T0 + PRESENCE_STALE_AFTER_MS + PRESENCE_GONE_AFTER_STALE_MS + 1);
    expect(map.size()).toBe(0);
    expect(transitions.size()).toBe(0);
  });

  test("a shared transition log keeps projections and presence in agreement", () => {
    const transitions = new ActivityTransitionTracker();
    const map = new BrokerPresenceMap({ transitions });
    map.observe({ status: status("blocked", T0) }, T0);

    // A fleet-surface projection reading the same log sees the same instant.
    const fromLog = transitions.record("agent-1", "blocked", T0 + 60_000, T0 + 60_000);
    expect(fromLog).toBe(map.get("agent-1")!.transitionAt);
  });
});

describe("ActivityTransitionTracker", () => {
  test("seeds from the observed timestamp so restarts recover real history", () => {
    const tracker = new ActivityTransitionTracker();
    const startedNineMinutesAgo = T0 - 9 * 60_000;

    // Broker just restarted; the flight has been running for nine minutes.
    // Stamping "now" would reset every agent's clock to zero.
    expect(tracker.record("agent-1", "working", startedNineMinutesAgo, T0)).toBe(startedNineMinutesAgo);
  });

  test("clamps future-dated observations to now", () => {
    const tracker = new ActivityTransitionTracker();
    expect(tracker.record("agent-1", "working", T0 + 60_000, T0)).toBe(T0);
  });

  test("repeat observations of the same activity keep the original instant", () => {
    const tracker = new ActivityTransitionTracker();
    tracker.record("agent-1", "thinking", T0, T0);
    expect(tracker.record("agent-1", "thinking", T0 + 45_000, T0 + 45_000)).toBe(T0);
  });
});
