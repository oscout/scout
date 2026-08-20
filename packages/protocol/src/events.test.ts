import { describe, expect, test } from "bun:test";

import {
  OPENSCOUT_CONTROL_EVENT_VERSION,
  normalizeControlEvent,
} from "./events.js";
import type {
  ControlEvent,
  NodeUpsertedEvent,
  ActorRegisteredEvent,
  AgentRegisteredEvent,
  AgentEndpointUpsertedEvent,
  AgentEndpointDeletedEvent,
  ConversationUpsertedEvent,
  BindingUpsertedEvent,
  MessagePostedEvent,
  ConversationReadCursorUpdatedEvent,
  InvocationRequestedEvent,
  FlightUpdatedEvent,
  DeliveryPlannedEvent,
  DeliveryAttemptedEvent,
  DeliveryStateChangedEvent,
  CollaborationUpsertedEvent,
  CollaborationEventAppendedEvent,
  ScoutDispatchedEvent,
} from "./events.js";

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness guard
// ---------------------------------------------------------------------------
// If any variant is added, removed, or renamed in ControlEvent, the default
// branch below will fail to compile because `event` won't narrow to `never`.
function assertExhaustiveControlEvent(event: ControlEvent): string {
  switch (event.kind) {
    case "node.upserted":
      return event.payload.node.id;
    case "actor.registered":
      return event.payload.actor.id;
    case "agent.registered":
      return event.payload.agent.id;
    case "agent.endpoint.upserted":
      return event.payload.endpoint.agentId;
    case "agent.endpoint.deleted":
      return event.payload.endpointId;
    case "conversation.upserted":
      return event.payload.conversation.id;
    case "binding.upserted":
      return event.payload.binding.id;
    case "message.posted":
      return event.payload.message.id;
    case "conversation.read_cursor.updated":
      return event.payload.cursor.conversationId;
    case "invocation.requested":
      return event.payload.invocation.id;
    case "flight.updated":
      return event.payload.flight.id;
    case "delivery.planned":
      return event.payload.delivery.id;
    case "delivery.attempted":
      return event.payload.attempt.id;
    case "delivery.state.changed":
      return event.payload.delivery.id;
    case "collaboration.upserted":
      return event.payload.record.id;
    case "collaboration.event.appended":
      return event.payload.event.id;
    case "scout.dispatched":
      return event.payload.dispatch.id;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// Keep TypeScript happy — the function is referenced so it won't be tree-shaken
void assertExhaustiveControlEvent;

// ---------------------------------------------------------------------------
// Runtime assertions
// ---------------------------------------------------------------------------

describe("ControlEvent variants", () => {
  test("agent.registered carries agent payload", () => {
    const event: AgentRegisteredEvent = {
      id: "evt-001",
      kind: "agent.registered",
      ts: 1_700_000_000_000,
      actorId: "actor-1",
      payload: {
        agent: {
          id: "agent-1",
          label: "hudson",
          harness: "codex",
          projectPath: "/dev/app",
          createdAt: 1_700_000_000_000,
        } as AgentRegisteredEvent["payload"]["agent"],
      },
    };

    expect(event.kind).toBe("agent.registered");
    expect(event.payload.agent.id).toBe("agent-1");
    expect(event.payload.agent.label).toBe("hudson");
  });

  test("message.posted carries message payload", () => {
    const event: MessagePostedEvent = {
      id: "evt-002",
      kind: "message.posted",
      ts: 1_700_000_001_000,
      actorId: "actor-2",
      payload: {
        message: {
          id: "msg-1",
          conversationId: "conv-1",
          role: "user",
          text: "hello",
          createdAt: 1_700_000_001_000,
        } as MessagePostedEvent["payload"]["message"],
      },
    };

    expect(event.kind).toBe("message.posted");
    expect(event.payload.message.id).toBe("msg-1");
    expect(event.payload.message.conversationId).toBe("conv-1");
  });

  test("agent.endpoint.upserted carries endpoint payload", () => {
    const event: AgentEndpointUpsertedEvent = {
      id: "evt-003",
      kind: "agent.endpoint.upserted",
      ts: 1_700_000_002_000,
      actorId: "actor-1",
      payload: {
        endpoint: {
          id: "ep-1",
          agentId: "agent-1",
          kind: "sse",
          url: "http://localhost:8080/events",
          createdAt: 1_700_000_002_000,
        } as AgentEndpointUpsertedEvent["payload"]["endpoint"],
      },
    };

    expect(event.kind).toBe("agent.endpoint.upserted");
    expect(event.payload.endpoint.agentId).toBe("agent-1");
  });

  test("agent.endpoint.deleted carries endpointId", () => {
    const event: AgentEndpointDeletedEvent = {
      id: "evt-004",
      kind: "agent.endpoint.deleted",
      ts: 1_700_000_003_000,
      actorId: "actor-1",
      payload: { endpointId: "ep-1" },
    };

    expect(event.kind).toBe("agent.endpoint.deleted");
    expect(event.payload.endpointId).toBe("ep-1");
  });

  test("collaboration.upserted carries record payload", () => {
    const event: CollaborationUpsertedEvent = {
      id: "evt-005",
      kind: "collaboration.upserted",
      ts: 1_700_000_004_000,
      actorId: "actor-1",
      payload: {
        record: {
          id: "collab-1",
          kind: "work_item",
          title: "Fix the bug",
          createdById: "actor-1",
          ownerId: "actor-1",
          nextMoveOwnerId: "actor-1",
          state: "open",
          acceptanceState: "none",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      },
    };

    expect(event.kind).toBe("collaboration.upserted");
    expect(event.payload.record.id).toBe("collab-1");
    expect(event.payload.record.kind).toBe("work_item");
  });

  test("collaboration.event.appended carries collaboration event payload", () => {
    const event: CollaborationEventAppendedEvent = {
      id: "evt-006",
      kind: "collaboration.event.appended",
      ts: 1_700_000_005_000,
      actorId: "actor-1",
      payload: {
        event: {
          id: "cev-1",
          recordId: "collab-1",
          recordKind: "work_item",
          kind: "created",
          actorId: "actor-1",
          at: 1_700_000_000_000,
        },
      },
    };

    expect(event.kind).toBe("collaboration.event.appended");
    expect(event.payload.event.recordId).toBe("collab-1");
    expect(event.payload.event.kind).toBe("created");
  });

  test("delivery.state.changed carries previousStatus", () => {
    const event: DeliveryStateChangedEvent = {
      id: "evt-007",
      kind: "delivery.state.changed",
      ts: 1_700_000_006_000,
      actorId: "actor-1",
      payload: {
        delivery: {
          id: "del-1",
          messageId: "msg-1",
          targetId: "agent-1",
          status: "delivered",
          createdAt: 1_700_000_000_000,
        } as DeliveryStateChangedEvent["payload"]["delivery"],
        previousStatus: "pending",
      },
    };

    expect(event.kind).toBe("delivery.state.changed");
    expect(event.payload.previousStatus).toBe("pending");
    expect(event.payload.delivery.status).toBe("delivered");
  });

  test("nodeId is optional on ControlEventBase", () => {
    const withNode: AgentRegisteredEvent = {
      id: "evt-008",
      kind: "agent.registered",
      ts: 1_700_000_007_000,
      actorId: "actor-1",
      nodeId: "node-1",
      payload: {
        agent: {
          id: "agent-2",
          label: "scout",
          harness: "claude",
          projectPath: "/dev/scout",
          createdAt: 1_700_000_007_000,
        } as AgentRegisteredEvent["payload"]["agent"],
      },
    };
    const withoutNode: AgentRegisteredEvent = {
      id: "evt-009",
      kind: "agent.registered",
      ts: 1_700_000_008_000,
      actorId: "actor-1",
      payload: {
        agent: {
          id: "agent-3",
          label: "runner",
          harness: "claude",
          projectPath: "/dev/runner",
          createdAt: 1_700_000_008_000,
        } as AgentRegisteredEvent["payload"]["agent"],
      },
    };

    expect(withNode.nodeId).toBe("node-1");
    expect(withoutNode.nodeId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Envelope versioning
// ---------------------------------------------------------------------------

describe("control-event envelope version", () => {
  test("OPENSCOUT_CONTROL_EVENT_VERSION is 1", () => {
    expect(OPENSCOUT_CONTROL_EVENT_VERSION).toBe(1);
  });

  test("normalizeControlEvent stamps a missing v", () => {
    const legacy: AgentEndpointDeletedEvent = {
      id: "evt-100",
      kind: "agent.endpoint.deleted",
      ts: 1_700_000_009_000,
      actorId: "actor-1",
      payload: { endpointId: "ep-9" },
    };

    expect(legacy.v).toBeUndefined();

    const normalized = normalizeControlEvent(legacy);

    expect(normalized.v).toBe(1);
    // Pure: the input is not mutated.
    expect(legacy.v).toBeUndefined();
    // Rest of the envelope is preserved.
    expect(normalized.id).toBe("evt-100");
    expect(normalized.payload.endpointId).toBe("ep-9");
  });

  test("normalizeControlEvent preserves an existing v", () => {
    const versioned: AgentEndpointDeletedEvent = {
      id: "evt-101",
      kind: "agent.endpoint.deleted",
      ts: 1_700_000_010_000,
      actorId: "actor-1",
      v: 1,
      payload: { endpointId: "ep-10" },
    };

    const normalized = normalizeControlEvent(versioned);

    expect(normalized.v).toBe(1);
    expect(normalized.id).toBe("evt-101");
  });

  test("events with and without v both satisfy ControlEvent (legacy-compat)", () => {
    // Compile-time check: the optional `v` keeps both shapes assignable.
    const withoutV: ControlEvent = {
      id: "evt-102",
      kind: "agent.endpoint.deleted",
      ts: 1_700_000_011_000,
      actorId: "actor-1",
      payload: { endpointId: "ep-11" },
    };
    const withV: ControlEvent = {
      id: "evt-103",
      kind: "agent.endpoint.deleted",
      ts: 1_700_000_012_000,
      actorId: "actor-1",
      v: 1,
      payload: { endpointId: "ep-12" },
    };

    expect(withoutV.v).toBeUndefined();
    expect(withV.v).toBe(1);
  });
});
