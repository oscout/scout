import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import { presenceLifecycle } from "@openscout/protocol";
import type {
  AgentDefinition,
  AgentEndpoint,
  ControlEvent,
  FlightRecord,
  PresenceUpdatedEvent,
} from "@openscout/protocol";

import { BrokerControlStreamService } from "./broker-control-stream-service.js";
import { BrokerPresenceService, type PresenceProjectionSnapshot } from "./broker-presence-service.js";
import {
  publishControlEvent,
  publishEphemeralControlEvent,
  replaceControlEventBacklog,
  snapshotRecentControlEvents,
  subscribeControlEvents,
} from "./broker-control-events.js";

const T0 = 1_700_000_000_000;

class FakeRequest extends EventEmitter {}

class FakeResponse {
  readonly chunks: string[] = [];
  writeHead(): void {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {}
  body(): string {
    return this.chunks.join("");
  }
}

function agent(id: string, displayName: string): AgentDefinition {
  return {
    id,
    kind: "agent",
    displayName,
    definitionId: `${id}-def`,
    agentClass: "worker",
    capabilities: [],
  } as unknown as AgentDefinition;
}

function flight(input: Partial<FlightRecord> & Pick<FlightRecord, "id" | "state">): FlightRecord {
  return {
    invocationId: `${input.id}-inv`,
    targetAgentId: "agent-1",
    startedAt: T0,
    ...input,
  } as FlightRecord;
}

/** A live agent: the endpoint heartbeat is what keeps presence fresh. */
function heartbeat(lastSeenAt: number): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "claude",
    transport: "local_socket",
    state: "active",
    metadata: { lastSeenAt },
  } as AgentEndpoint;
}

function snapshotWith(overrides: Partial<PresenceProjectionSnapshot> = {}): PresenceProjectionSnapshot {
  return {
    agents: { "agent-1": agent("agent-1", "hopper") },
    endpoints: {},
    invocations: {},
    flights: {},
    collaborationRecords: {},
    ...overrides,
  } as PresenceProjectionSnapshot;
}

function createService(initial: PresenceProjectionSnapshot) {
  let snapshot = initial;
  const published: PresenceUpdatedEvent[] = [];
  let sequence = 0;
  const service = new BrokerPresenceService({
    snapshot: () => snapshot,
    publish: (event) => published.push(event),
    createId: (prefix) => `${prefix}-${++sequence}`,
    actorId: "node-1",
    nodeId: "node-1",
  });
  return {
    published,
    service,
    setSnapshot: (next: PresenceProjectionSnapshot) => {
      snapshot = next;
    },
  };
}

describe("BrokerPresenceService", () => {
  test("first sample publishes one transition per agent", () => {
    const { published, service } = createService(snapshotWith({
      flights: { "flight-1": flight({ id: "flight-1", state: "running" }) },
    }));

    expect(service.sample(T0)).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]!.kind).toBe("presence.updated");
    expect(published[0]!.payload.beat.agentId).toBe("agent-1");
    expect(published[0]!.payload.beat.activity).toBe("working");
    expect(published[0]!.payload.beat.displayName).toBe("hopper");
  });

  test("steady state puts nothing on the wire", () => {
    const { published, service, setSnapshot } = createService(snapshotWith({
      endpoints: { "endpoint-1": heartbeat(T0) },
    }));

    service.sample(T0);
    published.length = 0;

    // Nine minutes of heartbeats, unchanged activity. The renderers keep
    // ageing the display from timestamps they already hold.
    for (let i = 1; i <= 36; i++) {
      const at = T0 + i * 15_000;
      setSnapshot(snapshotWith({ endpoints: { "endpoint-1": heartbeat(at) } }));
      expect(service.sample(at)).toBe(0);
    }
    expect(published).toHaveLength(0);

    const beat = service.presence.get("agent-1")!;
    expect(beat.transitionAt).toBe(T0);
    expect(beat.updatedAt).toBe(T0 + 36 * 15_000);
  });

  test("evidence that stopped refreshing decays once and does not flap back", () => {
    const { published, service } = createService(snapshotWith({
      endpoints: { "endpoint-1": heartbeat(T0) },
    }));
    service.sample(T0);
    published.length = 0;

    // The heartbeat stopped at T0. Presence decays on its own, and re-sampling
    // the same dead evidence must not resurrect and republish the agent.
    for (let i = 1; i <= 20; i++) {
      expect(service.sample(T0 + i * 15_000)).toBe(0);
    }

    expect(published).toHaveLength(0);
    expect(service.presence.size()).toBe(0);
  });

  test("a real transition publishes with the previous activity", () => {
    const { published, service, setSnapshot } = createService(snapshotWith({
      flights: { "flight-1": flight({ id: "flight-1", state: "running" }) },
    }));
    service.sample(T0);
    published.length = 0;

    const later = T0 + 60_000;
    setSnapshot(snapshotWith({
      flights: {
        "flight-1": flight({ id: "flight-1", state: "waiting", startedAt: later }),
      },
    }));

    expect(service.sample(later)).toBe(1);
    expect(published[0]!.payload.previousActivity).toBe("working");
    expect(published[0]!.payload.beat.activity).toBe("waiting_for_input");
    expect(published[0]!.payload.beat.transitionAt).toBe(later);
  });

  test("snapshotEvents hands a new subscriber the map, not a replay", () => {
    const { service } = createService(snapshotWith({
      flights: { "flight-1": flight({ id: "flight-1", state: "running" }) },
    }));
    service.sample(T0);

    const events = service.snapshotEvents(T0 + 1_000);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.beat.agentId).toBe("agent-1");
    expect(events[0]!.payload.previousActivity).toBeUndefined();
  });

  test("a flight running past the gone window stays present, fresh, and correctly aged", () => {
    // The canonical render this surface exists for: "thinking 9m". The flight
    // began nine minutes ago and never changed state; the endpoint has been
    // heartbeating every 15s the whole time. The activity must age from the
    // flight's start and the claim's freshness from the heartbeat. Reading one
    // as the other deleted the agent 105s in, while it was demonstrably alive.
    const live = (at: number) => snapshotWith({
      endpoints: { "endpoint-1": heartbeat(at) },
      flights: { "flight-1": flight({ id: "flight-1", state: "running" }) },
    });
    const { published, service, setSnapshot } = createService(live(T0));

    service.sample(T0);
    published.length = 0;

    for (let i = 1; i <= 36; i++) {
      const at = T0 + i * 15_000;
      setSnapshot(live(at));
      expect(service.sample(at)).toBe(0);
    }

    const at = T0 + 9 * 60_000;
    const beat = service.presence.get("agent-1");

    expect(beat).toBeDefined();
    expect(beat!.activity).toBe("working");
    expect(presenceLifecycle(beat!, at)).toBe("fresh");
    expect(at - beat!.transitionAt).toBe(9 * 60_000);
    expect(published).toHaveLength(0);
    expect(service.sweep(at)).toEqual([]);
  });

  test("a flight with no endpoint stays present on its own session acknowledgements", () => {
    // Not every executing agent has a registered endpoint. The session trace's
    // acknowledgements are the flight's own liveness evidence, and they keep a
    // long turn present exactly as an endpoint heartbeat would.
    const acked = (at: number) => snapshotWith({
      flights: {
        "flight-1": flight({
          id: "flight-1",
          state: "running",
          metadata: { sessionTrace: [{ sessionId: "s-1", startedAt: T0, lastAcknowledgedAt: at }] },
        }),
      },
    });
    const { service, setSnapshot } = createService(acked(T0));

    service.sample(T0);
    for (let i = 1; i <= 36; i++) {
      const at = T0 + i * 15_000;
      setSnapshot(acked(at));
      service.sample(at);
    }

    const at = T0 + 9 * 60_000;
    const beat = service.presence.get("agent-1");

    expect(beat).toBeDefined();
    expect(presenceLifecycle(beat!, at)).toBe("fresh");
    expect(at - beat!.transitionAt).toBe(9 * 60_000);
  });

  test("time-in-state survives a broker restart for endpoint-sourced activity", () => {
    // A restart clears the map and the transition log by design. What it must
    // not do is reset every agent's clock: the endpoint records when its
    // current turn started, so a nine-minute turn is still nine minutes old to
    // a broker that has only just come back.
    const at = T0 + 9 * 60_000;
    const { service } = createService(snapshotWith({
      endpoints: {
        "endpoint-1": {
          ...heartbeat(at),
          metadata: { lastSeenAt: at, lastStartedAt: T0 },
        } as AgentEndpoint,
      },
    }));

    service.sample(at);
    const beat = service.presence.get("agent-1")!;

    expect(beat.activity).toBe("working");
    expect(beat.transitionAt).toBe(T0);
    expect(at - beat.transitionAt).toBe(9 * 60_000);
  });

  test("expiry is silent — a claim nothing has re-verified drops without an event", () => {
    // The fixture is the point: this flight has no endpoint and no session
    // acknowledgement, so nothing has attested the agent is alive since it
    // started. An unverifiable claim must decay — that is the anti-resurrection
    // guarantee. A flight that *is* still attested stays, per the two tests
    // above; drawing that distinction is what this suite previously lacked.
    const { published, service } = createService(snapshotWith({
      flights: { "flight-1": flight({ id: "flight-1", state: "running" }) },
    }));
    service.sample(T0);
    published.length = 0;

    const dropped = service.sweep(T0 + 10 * 60_000);

    expect(dropped).toEqual(["agent-1"]);
    expect(service.presence.size()).toBe(0);
    expect(published).toHaveLength(0);
  });
});

describe("presence creates zero durable records", () => {
  function presenceEvent(id: string): PresenceUpdatedEvent {
    return {
      id,
      kind: "presence.updated",
      ts: T0,
      actorId: "node-1",
      payload: {
        beat: {
          agentId: "agent-1",
          activity: "executing",
          phase: "running",
          transitionAt: T0,
          updatedAt: T0,
          staleAt: T0 + 45_000,
          confidence: 0.9,
        },
      },
    };
  }

  test("streamEvent refuses to enqueue a presence event but still fans it out", () => {
    const enqueued: ControlEvent[] = [];
    const service = new BrokerControlStreamService({
      enqueueEvent: (event) => enqueued.push(event),
      findDeliveryById: () => undefined,
      listDeliveries: () => [],
      messageById: () => undefined,
      invocationById: () => undefined,
    });
    const response = new FakeResponse();
    service.addEventStream({
      request: new FakeRequest() as never,
      response: response as never,
      hello: {},
    });

    service.streamEvent(presenceEvent("evt-p1"));

    // `enqueueEvent` is the SQLite write path.
    expect(enqueued).toHaveLength(0);
    expect(response.body()).toContain("event: presence.updated");
  });

  test("presence never enters the shared control-event backlog", () => {
    replaceControlEventBacklog([], 500);
    const seen: ControlEvent[] = [];
    const unsubscribe = subscribeControlEvents((event) => seen.push(event));

    try {
      publishControlEvent(presenceEvent("evt-p2"));
      publishEphemeralControlEvent(presenceEvent("evt-p3"));

      // Both reached live subscribers...
      expect(seen.map((event) => event.id)).toEqual(["evt-p2", "evt-p3"]);
      // ...and neither can evict a real control event from the window.
      expect(snapshotRecentControlEvents()).toHaveLength(0);
    } finally {
      unsubscribe();
      replaceControlEventBacklog([], 500);
    }
  });

  test("replaceControlEventBacklog drops any persisted presence events on boot", () => {
    replaceControlEventBacklog([
      presenceEvent("evt-p4"),
      {
        id: "evt-real",
        kind: "agent.endpoint.deleted",
        ts: T0,
        actorId: "node-1",
        payload: { endpointId: "ep-1" },
      },
    ], 500);

    try {
      expect(snapshotRecentControlEvents().map((event) => event.id)).toEqual(["evt-real"]);
    } finally {
      replaceControlEventBacklog([], 500);
    }
  });
});
