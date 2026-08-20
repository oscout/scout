import { describe, expect, test } from "bun:test";

import type { DurableAction, DurableActionHeartbeatInput } from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableActionHttpService } from "./broker-durable-action-http-service.js";

function action(input: Partial<DurableAction> = {}): DurableAction {
  return {
    id: "action-1",
    kind: "message_delivery",
    subjectId: "delivery-1",
    authorityCellId: "node-local",
    state: "leased",
    leaseOwner: "worker-1",
    leaseGeneration: 2,
    leaseExpiresAt: 1_500,
    createdAt: 100,
    updatedAt: 100,
    metadata: {},
    ...input,
  };
}

function createHarness(input: {
  heartbeatResult?: DurableAction | null;
  currentAction?: DurableAction | null;
} = {}) {
  const committedEntries: BrokerJournalEntry[][] = [];
  const heartbeats: DurableActionHeartbeatInput[] = [];
  const service = new BrokerDurableActionHttpService({
    async runDurableWrite(work) {
      return await work();
    },
    async commitEntries(entries) {
      const normalized = Array.isArray(entries) ? entries : [entries];
      committedEntries.push(normalized);
      return normalized;
    },
    async heartbeatDurableAction(inputHeartbeat) {
      heartbeats.push(inputHeartbeat);
      return input.heartbeatResult === undefined ? action({
        leaseExpiresAt: inputHeartbeat.heartbeatAt + inputHeartbeat.leaseMs,
        updatedAt: inputHeartbeat.heartbeatAt,
      }) : input.heartbeatResult;
    },
    getDurableAction: () => input.currentAction,
    now: () => 1_000,
  });

  return {
    committedEntries,
    heartbeats,
    service,
  };
}

describe("BrokerDurableActionHttpService", () => {
  test("records durable actions through the durable write queue", async () => {
    const harness = createHarness();
    const nextAction = action();

    await expect(harness.service.recordAction(nextAction)).resolves.toEqual({
      ok: true,
      actionId: "action-1",
    });
    expect(harness.committedEntries).toEqual([
      [{ kind: "durable.action.record", action: nextAction }],
    ]);
    await expect(harness.service.recordAction(action({ id: "" })))
      .rejects.toThrow("action.id is required");
  });

  test("records heartbeats and returns lease details", async () => {
    const harness = createHarness();

    await expect(harness.service.heartbeat(" action-1 ", {
      owner: " worker-1 ",
      generation: 2,
      leaseMs: 500,
    })).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        actionId: "action-1",
        leaseOwner: "worker-1",
        leaseGeneration: 2,
        leaseExpiresAt: 1_500,
      },
    });
    expect(harness.heartbeats).toEqual([
      {
        actionId: "action-1",
        owner: "worker-1",
        generation: 2,
        leaseMs: 500,
        heartbeatAt: 1_000,
      },
    ]);
  });

  test("maps missing and stale heartbeat leases to HTTP-style results", async () => {
    const missing = createHarness({ heartbeatResult: null, currentAction: null });
    await expect(missing.service.heartbeat("missing", {
      owner: "worker-1",
      generation: 1,
      leaseMs: 500,
      heartbeatAt: 200,
    })).resolves.toEqual({
      status: 404,
      body: {
        error: "not_found",
        detail: "durable action not found",
      },
    });

    const stale = createHarness({ heartbeatResult: null, currentAction: action() });
    await expect(stale.service.heartbeat("action-1", {
      owner: "worker-2",
      generation: 1,
      leaseMs: 500,
      heartbeatAt: 200,
    })).resolves.toEqual({
      status: 409,
      body: {
        error: "conflict",
        detail: "durable action lease is stale, terminal, or owned by another worker",
      },
    });
  });

  test("validates heartbeat input fields", async () => {
    const harness = createHarness();

    await expect(harness.service.heartbeat("", {
      owner: "worker-1",
      generation: 1,
      leaseMs: 500,
    })).rejects.toThrow("actionId and owner are required.");
    await expect(harness.service.heartbeat("action-1", {
      owner: "",
      generation: 1,
      leaseMs: 500,
    })).rejects.toThrow("actionId and owner are required.");
    await expect(harness.service.heartbeat("action-1", {
      owner: "worker-1",
      generation: -1,
      leaseMs: 500,
    })).rejects.toThrow("generation must be a non-negative number.");
    await expect(harness.service.heartbeat("action-1", {
      owner: "worker-1",
      generation: 1,
      leaseMs: 0,
    })).rejects.toThrow("leaseMs must be a positive number.");
  });
});
