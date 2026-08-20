import { describe, expect, test } from "bun:test";

import type {
  ControlEvent,
  DeliveryAttempt,
  DeliveryIntent,
  DurableAction,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDeliveryStore, isDeliveryClaimable } from "./broker-delivery-store.js";
import { BrokerDurableStore } from "./broker-durable-store.js";

class TestDeliveryJournal {
  readonly appended: BrokerJournalEntry[][] = [];
  readonly deliveries = new Map<string, DeliveryIntent>();
  readonly durableActions = new Map<string, DurableAction>();
  readonly attempts: DeliveryAttempt[] = [];

  async appendEntries(entries: BrokerJournalEntry[]): Promise<BrokerJournalEntry[]> {
    this.appended.push(entries);
    for (const entry of entries) {
      switch (entry.kind) {
        case "deliveries.record":
          for (const delivery of entry.deliveries) {
            this.deliveries.set(delivery.id, delivery);
          }
          break;
        case "delivery.status.update": {
          const previous = this.deliveries.get(entry.deliveryId);
          if (previous) {
            this.deliveries.set(entry.deliveryId, {
              ...previous,
              status: entry.status,
              metadata: {
                ...(previous.metadata ?? {}),
                ...(entry.metadata ?? {}),
              },
              leaseOwner: entry.leaseOwner ?? undefined,
              leaseExpiresAt: entry.leaseExpiresAt ?? undefined,
            });
          }
          break;
        }
        case "delivery.attempt.record":
          this.attempts.push(entry.attempt);
          break;
        case "durable.action.record":
          this.durableActions.set(entry.action.id, entry.action);
          break;
        case "durable.action.heartbeat": {
          const current = this.durableActions.get(entry.input.actionId);
          if (current) {
            this.durableActions.set(entry.input.actionId, {
              ...current,
              leaseExpiresAt: entry.input.heartbeatAt + entry.input.leaseMs,
              updatedAt: entry.input.heartbeatAt,
            });
          }
          break;
        }
        default:
          break;
      }
    }
    return entries;
  }

  listDeliveries(): DeliveryIntent[] {
    return [...this.deliveries.values()];
  }

  getDurableAction(actionId: string): DurableAction | undefined {
    return this.durableActions.get(actionId);
  }
}

function createTestDeliveryStore() {
  const journal = new TestDeliveryJournal();
  const events: ControlEvent[] = [];
  const durableStore = new BrokerDurableStore({
    journal,
    projection: {
      async applyEntries() {
        return [];
      },
    },
    threadEvents: {
      publish() {},
    },
  });
  const store = new BrokerDeliveryStore({
    journal,
    durableStore,
    nodeId: "node-1",
    createEventId: () => `event-${events.length + 1}`,
    publishEvent: (event) => {
      events.push(event);
    },
  });

  return { journal, events, store };
}

function testDelivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "message-1",
    targetId: "agent-1",
    targetKind: "agent",
    transport: "local_socket",
    reason: "direct_message",
    policy: "best_effort",
    status: "pending",
    ...input,
  };
}

function testDurableAction(input: Partial<DurableAction> = {}): DurableAction {
  return {
    id: "action-1",
    kind: "message_delivery",
    subjectId: "delivery-1",
    authorityCellId: "node-1",
    state: "running",
    leaseOwner: "worker-1",
    leaseGeneration: 2,
    leaseExpiresAt: 100,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

describe("BrokerDeliveryStore", () => {
  test("identifies delivery claimability from status and lease expiry", () => {
    expect(isDeliveryClaimable(testDelivery({ status: "pending" }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "accepted" }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "deferred" }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "leased", leaseExpiresAt: 9 }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "leased", leaseExpiresAt: 11 }), 10)).toBe(false);
    expect(isDeliveryClaimable(testDelivery({ status: "completed" }), 10)).toBe(false);
  });

  test("claims a pending delivery and publishes the state change", async () => {
    const { journal, events, store } = createTestDeliveryStore();
    await store.recordDelivery(testDelivery());

    const claimed = await store.claimDelivery({
      targetId: "agent-1",
      leaseOwner: "worker-1",
      leaseMs: 1_000,
    });

    expect(claimed).toEqual(expect.objectContaining({
      id: "delivery-1",
      status: "leased",
      leaseOwner: "worker-1",
    }));
    expect(journal.deliveries.get("delivery-1")).toEqual(expect.objectContaining({
      status: "leased",
      leaseOwner: "worker-1",
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      kind: "delivery.state.changed",
      payload: expect.objectContaining({
        previousStatus: "pending",
      }),
    }));
  });

  test("rejects status updates when the active lease is owned by another worker", async () => {
    const { store } = createTestDeliveryStore();
    await store.recordDelivery(testDelivery({
      status: "leased",
      leaseOwner: "worker-1",
      leaseExpiresAt: Date.now() + 10_000,
    }));

    await expect(store.updateDeliveryStatus({
      deliveryId: "delivery-1",
      status: "acknowledged",
      expectedLeaseOwner: "worker-2",
      requireActiveLease: true,
    })).rejects.toThrow("delivery lease is missing, expired, or owned by another worker");
  });

  test("records delivery attempts and durable action heartbeats", async () => {
    const { journal, store } = createTestDeliveryStore();
    const action = testDurableAction();
    await journal.appendEntries([{ kind: "durable.action.record", action }]);

    await store.recordDeliveryAttempt({
      id: "attempt-1",
      deliveryId: "delivery-1",
      attempt: 1,
      status: "sent",
      createdAt: 10,
    });
    const heartbeat = await store.heartbeatDurableAction({
      actionId: "action-1",
      owner: "worker-1",
      generation: 2,
      leaseMs: 500,
      heartbeatAt: 50,
    });

    expect(journal.attempts).toContainEqual(expect.objectContaining({
      id: "attempt-1",
      status: "sent",
    }));
    expect(heartbeat).toEqual(expect.objectContaining({
      id: "action-1",
      leaseExpiresAt: 550,
      updatedAt: 50,
    }));
    expect(journal.durableActions.get("action-1")).toEqual(expect.objectContaining({
      leaseExpiresAt: 550,
      updatedAt: 50,
    }));
  });
});
