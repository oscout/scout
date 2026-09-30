import { describe, expect, test } from "bun:test";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  AgentState,
  ConversationDefinition,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
  WorkItemRecord,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { RuntimeActorIdentity } from "./registry.js";
import {
  applyRegistryRetentionPlan,
  createRegistryRetentionEvaluator,
  registryRetentionPlan,
  type RegistryRetentionPlan,
} from "./broker-registry-retention.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
const LOCAL = "node-local";

function createRuntime() {
  return createInMemoryControlRuntime({}, { localNodeId: LOCAL });
}

function node(id: string, lastSeenAt: number): NodeDefinition {
  return {
    id,
    meshId: "mesh-1",
    name: id,
    advertiseScope: "local",
    registeredAt: lastSeenAt,
    lastSeenAt,
  };
}

function actor(id: string, kind: ActorIdentity["kind"] = "agent"): ActorIdentity {
  return { id, kind, displayName: id };
}

function agent(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    kind: "agent",
    displayName: id,
    definitionId: id,
    agentClass: "builder",
    capabilities: ["chat", "execute"],
    wakePolicy: "on_demand",
    homeNodeId: LOCAL,
    authorityNodeId: LOCAL,
    advertiseScope: "local",
    ...extra,
  };
}

function endpoint(
  id: string,
  agentId: string,
  nodeId: string,
  state: AgentState,
  metadata: Record<string, unknown> = {},
): AgentEndpoint {
  return {
    id,
    agentId,
    nodeId,
    harness: "codex",
    transport: "local_socket",
    state,
    metadata,
  };
}

function conversation(participantIds: string[]): ConversationDefinition {
  return {
    id: "conv-1",
    kind: "channel",
    title: "Room",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: LOCAL,
    participantIds,
  };
}

function message(actorId: string): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    actorId,
    originNodeId: LOCAL,
    class: "agent",
    body: "hello",
    visibility: "private",
    policy: "durable",
    createdAt: NOW - DAY,
  };
}

function invocation(targetAgentId: string): InvocationRequest {
  return {
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: LOCAL,
    targetAgentId,
    action: "execute",
    task: "Run the job.",
    ensureAwake: true,
    stream: true,
    createdAt: NOW - DAY,
  };
}

function workItem(ownerId: string, state: WorkItemRecord["state"] = "open"): WorkItemRecord {
  return {
    id: "work-1",
    kind: "work_item",
    state,
    acceptanceState: "none",
    title: "Open work",
    createdById: "operator",
    ownerId,
    nextMoveOwnerId: ownerId,
    createdAt: NOW - 8 * DAY,
    updatedAt: NOW - 8 * DAY,
  };
}

function flight(invocationId: string, targetAgentId: string, state: FlightRecord["state"]): FlightRecord {
  return {
    id: "flt-1",
    invocationId,
    requesterId: "operator",
    targetAgentId,
    state,
    startedAt: NOW - DAY,
    completedAt: state === "completed" ? NOW - DAY + 1_000 : undefined,
  };
}

function plan(runtime: ReturnType<typeof createRuntime>): RegistryRetentionPlan {
  return registryRetentionPlan(runtime.snapshot(), { nodeId: LOCAL, now: NOW });
}

/** Seeds the canonical stale shape: a dead historical node hosting an
 * 8-day-old offline relay-registry endpoint, its agent, and its actor. */
async function seedStaleRegistration(
  runtime: ReturnType<typeof createRuntime>,
  options: { nodeId?: string; endpointMetadata?: Record<string, unknown>; agentId?: string } = {},
) {
  const nodeId = options.nodeId ?? "node-historic";
  const agentId = options.agentId ?? "agent-1";
  await runtime.upsertNode(node(nodeId, NOW - 30 * DAY));
  await runtime.upsertActor(actor(agentId));
  await runtime.upsertAgent(agent(agentId, { homeNodeId: nodeId, authorityNodeId: nodeId }));
  await runtime.upsertEndpoint(endpoint(agentId === "agent-1" ? "ep-1" : `ep-${agentId}`, agentId, nodeId, "offline", {
    source: "relay-agent-registry",
    retiredAt: NOW - 8 * DAY,
    ...options.endpointMetadata,
  }));
  return { agentId, endpointId: agentId === "agent-1" ? "ep-1" : `ep-${agentId}`, nodeId };
}

describe("registryRetentionPlan", () => {
  test("plans a stale offline endpoint on a dead node plus its unreferenced agent and actor", async () => {
    const runtime = createRuntime();
    await seedStaleRegistration(runtime);

    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-1"],
      agentIds: ["agent-1"],
      actorIds: ["agent-1"],
    });
  });

  test("keeps records on a live remote peer node", async () => {
    const runtime = createRuntime();
    await runtime.upsertNode(node("node-peer", NOW - 60 * 60 * 1_000));
    await runtime.upsertActor(actor("agent-1"));
    await runtime.upsertAgent(agent("agent-1", { homeNodeId: LOCAL, authorityNodeId: "node-peer" }));
    await runtime.upsertEndpoint(endpoint("ep-1", "agent-1", "node-peer", "offline", {
      source: "relay-agent-registry",
      retiredAt: NOW - 8 * DAY,
    }));

    expect(plan(runtime)).toEqual({ endpointIds: [], agentIds: [], actorIds: [] });
  });

  test("keeps an agent with a live-state endpoint while planning its stale offline sibling", async () => {
    const runtime = createRuntime();
    await runtime.upsertActor(actor("agent-1"));
    await runtime.upsertAgent(agent("agent-1"));
    await runtime.upsertEndpoint(endpoint("ep-idle", "agent-1", LOCAL, "idle", {
      lastActivityAt: NOW - 60 * 60 * 1_000,
    }));
    await runtime.upsertEndpoint(endpoint("ep-old", "agent-1", LOCAL, "offline", {
      retiredAt: NOW - 8 * DAY,
    }));

    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-old"],
      agentIds: [],
      actorIds: [],
    });
  });

  test("keeps an actor that authored a message while planning its endpoint and agent", async () => {
    const runtime = createRuntime();
    await seedStaleRegistration(runtime);
    await runtime.commitMessage(message("agent-1"), []);

    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-1"],
      agentIds: ["agent-1"],
      actorIds: [],
    });
  });

  test("keeps an actor that owns a collaboration record — ownership outlives creation", async () => {
    const runtime = createRuntime();
    await seedStaleRegistration(runtime);
    // Someone else opened the work item; 'agent-1' only owns it. owner_id and
    // next_move_owner_id are ON DELETE SET NULL — deleting the actor would
    // silently erase the owner of open work.
    await runtime.upsertCollaboration(workItem("agent-1"));

    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-1"],
      agentIds: ["agent-1"],
      actorIds: [],
    });
  });

  test("keeps an agent targeted by a running flight", async () => {
    const runtime = createRuntime();
    await seedStaleRegistration(runtime);
    await runtime.commitInvocation(invocation("agent-1"), flight("inv-1", "agent-1", "running"));

    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-1"],
      agentIds: [],
      actorIds: [],
    });
  });

  test("plans a stale channel member — membership is not evidence of life", async () => {
    const runtime = createRuntime();
    await seedStaleRegistration(runtime);
    await runtime.upsertConversation(conversation(["agent-1", "operator"]));

    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-1"],
      agentIds: ["agent-1"],
      actorIds: ["agent-1"],
    });
  });

  test("ages an endpoint-less, timestamp-less agent by its actor's createdAt", async () => {
    const runtime = createRuntime();
    // No endpoints at all, no metadata timestamps — only the actor stamp.
    await runtime.upsertActor({ ...actor("agent-old"), createdAt: NOW - 8 * DAY });
    await runtime.upsertAgent(agent("agent-old"));
    await runtime.upsertActor({ ...actor("agent-new"), createdAt: NOW - 2 * DAY });
    await runtime.upsertAgent(agent("agent-new"));

    expect(plan(runtime)).toEqual({
      endpointIds: [],
      agentIds: ["agent-old"],
      actorIds: ["agent-old"],
    });
  });

  test("keeps an agent with no actor row and no other age evidence", async () => {
    const runtime = createRuntime();
    await runtime.upsertAgent(agent("agent-orphan"));
    // upsertAgent synthesizes the actor; remove it so the agent truly has
    // no age evidence anywhere.
    runtime.deleteActor("agent-orphan");

    expect(plan(runtime)).toEqual({ endpointIds: [], agentIds: [], actorIds: [] });
  });

  test("keeps an endpoint younger than the retention window", async () => {
    const runtime = createRuntime();
    await seedStaleRegistration(runtime, {
      endpointMetadata: { retiredAt: NOW - 2 * DAY },
    });

    expect(plan(runtime)).toEqual({ endpointIds: [], agentIds: [], actorIds: [] });
  });

  test("keeps an endpoint with no timestamps — unknown age never expires", async () => {
    const runtime = createRuntime();
    await runtime.upsertNode(node("node-historic", NOW - 30 * DAY));
    await runtime.upsertActor(actor("agent-1"));
    await runtime.upsertAgent(agent("agent-1", { homeNodeId: "node-historic", authorityNodeId: "node-historic" }));
    await runtime.upsertEndpoint(endpoint("ep-1", "agent-1", "node-historic", "offline", {
      source: "relay-agent-registry",
    }));

    expect(plan(runtime)).toEqual({ endpointIds: [], agentIds: [], actorIds: [] });
  });

  test("plans a session actor with no agent row when old enough and unreferenced", async () => {
    const runtime = createRuntime();
    await runtime.upsertActor({ ...actor("sess-1", "session"), createdAt: NOW - 8 * DAY });
    await runtime.upsertEndpoint(endpoint("ep-sess", "sess-1", LOCAL, "stopped", {
      source: "scout-cardless-session",
      lastSeenAt: NOW - 9 * DAY,
    }));
    // Same shape but stamped recently — kept.
    await runtime.upsertActor({ ...actor("sess-2", "session"), createdAt: NOW - DAY });

    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-sess"],
      agentIds: [],
      actorIds: ["sess-1"],
    });
  });

  test("keeps a cardless actor while any of its canonical endpoints is not a candidate", async () => {
    // Cardless actors have endpoints but no agent row — the surviving-agent
    // check alone never sees their plumbing. An actor is only a candidate
    // when EVERY endpoint pointing at it is itself a delete candidate.
    const runtime = createRuntime();
    await runtime.upsertActor({ ...actor("sess-cardless", "session"), createdAt: NOW - 8 * DAY });
    await runtime.upsertEndpoint(endpoint("ep-dead", "sess-cardless", "node-historic", "offline", {
      retiredAt: NOW - 8 * DAY,
    }));
    await runtime.upsertNode(node("node-historic", NOW - 30 * DAY));

    // One live endpoint vetoes the actor — and its stale sibling.
    await runtime.upsertEndpoint(endpoint("ep-live", "sess-cardless", LOCAL, "active", {
      lastSeenAt: NOW,
    }));
    expect(plan(runtime)).toEqual({
      endpointIds: ["ep-dead"],
      agentIds: [],
      actorIds: [],
    });
  });

  test("falls back to the store-supplied actorCreatedAtById map", async () => {
    const runtime = createRuntime();
    // Strip the stamp the runtime applies so this actor looks like a
    // pre-createdAt journal row; the durable store's created_at then supplies
    // the age via the input map.
    await runtime.upsertActor(actor("agent-1"));
    await runtime.upsertAgent(agent("agent-1"));
    delete (runtime.peek().actors["agent-1"] as RuntimeActorIdentity).createdAt;

    const withMap = registryRetentionPlan(runtime.snapshot(), {
      nodeId: LOCAL,
      now: NOW,
      actorCreatedAtById: new Map([["agent-1", NOW - 8 * DAY]]),
    });
    expect(withMap.agentIds).toEqual(["agent-1"]);
    expect(withMap.actorIds).toEqual(["agent-1"]);

    const withoutMap = plan(runtime);
    expect(withoutMap.agentIds).toEqual([]);
  });

  test("a throwing delete hook is counted, reported through onFailure, and does not abort the sweep", async () => {
    const synthetic: RegistryRetentionPlan = {
      endpointIds: ["e1", "e2"],
      agentIds: ["a1"],
      actorIds: [],
    };
    const calls: string[] = [];
    const failures: Array<{ category: string; id: string; error: unknown }> = [];
    const result = await applyRegistryRetentionPlan(synthetic, {
      deleteEndpoint: async (id) => {
        calls.push(`e:${id}`);
        if (id === "e1") throw new Error("boom");
      },
      deleteAgent: async (id) => { calls.push(`a:${id}`); },
      deleteActor: async (id) => { calls.push(`c:${id}`); },
    }, {
      onFailure: (category, id, error) => failures.push({ category, id, error }),
    });

    expect(result).toEqual({
      endpoints: 1, agents: 1, actors: 0,
      skipped: { endpoints: 0, agents: 0, actors: 0 },
      failures: 1,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.category).toBe("endpoint");
    expect(failures[0]?.id).toBe("e1");
    expect((failures[0]?.error as Error).message).toBe("boom");
    expect(calls).toEqual(["e:e1", "e:e2", "a:a1"]);
  });

  test("a hook that reports {deleted:false} increments skipped, not removed", async () => {
    // The write-time eligibility veto path: the durable delete declines the
    // record, the sweep must report a skip rather than a removal.
    const result = await applyRegistryRetentionPlan(
      { endpointIds: ["e1", "e2"], agentIds: ["a1"], actorIds: ["c1"] },
      {
        deleteEndpoint: async (id) => id === "e2"
          ? { deleted: false, reason: "revived" }
          : { deleted: true },
        deleteAgent: async () => ({ deleted: false, reason: "live-endpoint" }),
        deleteActor: async () => ({ deleted: true }),
      },
    );

    expect(result).toEqual({
      endpoints: 1, agents: 0, actors: 1,
      skipped: { endpoints: 1, agents: 1, actors: 0 },
      failures: 0,
    });
  });

  test("a slow batch halves the batch size, extends the yield, and logs once", async () => {
    const ids = Array.from({ length: 800 }, (_, i) => `e${String(i).padStart(4, "0")}`);
    let clock = 0;
    const yields: number[] = [];
    const paceLog: number[] = [];
    const calls: string[] = [];

    const result = await applyRegistryRetentionPlan(
      { endpointIds: ids, agentIds: [], actorIds: [] },
      {
        // 12 ms per delete: first 500-batch costs 6 s (slow), the halved
        // 250-batch costs 3 s (fine), the 50-tail is fast.
        deleteEndpoint: async (id) => { calls.push(id); clock += 12; },
        deleteAgent: async () => {},
        deleteActor: async () => {},
      },
      {
        batchSize: 500,
        now: () => clock,
        yieldTurn: async (ms = 0) => { yields.push(ms); },
        onPaceAdjust: (n) => paceLog.push(n),
      },
    );

    expect(result.endpoints).toBe(800);
    expect(calls).toEqual(ids);
    expect(paceLog).toEqual([250]);
    // 250ms yield after the slow batch, plain yield after the fast one, none
    // after the last.
    expect(yields).toEqual([250, 0]);
  });

  test("orders a large plan deterministically and the apply helper batches with yields", async () => {
    const runtime = createRuntime();
    await runtime.upsertActor(actor("agent-bulk"));
    await runtime.upsertAgent(agent("agent-bulk", { metadata: { registeredAt: NOW - 8 * DAY } }));
    // Insert out of order so sorted output proves ordering, not input luck.
    const count = 1_200;
    for (let i = count - 1; i >= 0; i--) {
      const id = `ep-${String(i).padStart(4, "0")}`;
      await runtime.upsertEndpoint(endpoint(id, "agent-bulk", LOCAL, "offline", {
        retiredAt: NOW - 8 * DAY,
      }));
    }

    const first = plan(runtime);
    const second = plan(runtime);
    expect(second).toEqual(first);
    expect(first.endpointIds).toHaveLength(count);
    expect(first.endpointIds).toEqual([...first.endpointIds].sort());
    expect(first.agentIds).toEqual(["agent-bulk"]);
    expect(first.actorIds).toEqual(["agent-bulk"]);

    const calls: string[] = [];
    let yields = 0;
    const result = await applyRegistryRetentionPlan(first, {
      deleteEndpoint: async (id) => { calls.push(`e:${id}`); },
      deleteAgent: async (id) => { calls.push(`a:${id}`); },
      deleteActor: async (id) => { calls.push(`c:${id}`); },
    }, {
      batchSize: 500,
      yieldTurn: async () => { yields += 1; },
    });

    expect(result).toEqual({
      endpoints: count, agents: 1, actors: 1,
      skipped: { endpoints: 0, agents: 0, actors: 0 },
      failures: 0,
    });
    // Endpoint order first, then agent, then actor — the plan's dependency order.
    expect(calls[0]).toBe("e:ep-0000");
    expect(calls[count - 1]).toBe(`e:ep-${String(count - 1).padStart(4, "0")}`);
    expect(calls[count]).toBe("a:agent-bulk");
    expect(calls[count + 1]).toBe("c:agent-bulk");
    // 1200 endpoints at batchSize 500 → batches 500/500/200 → two yields;
    // single-item agent and actor categories yield none.
    expect(yields).toBe(2);
  });
});

describe("createRegistryRetentionEvaluator", () => {
  const evaluator = () => createRegistryRetentionEvaluator({ nodeId: LOCAL, now: NOW });

  test("vetoes an endpoint revived or refreshed between planning and the delete", async () => {
    const runtime = createRuntime();
    const { endpointId } = await seedStaleRegistration(runtime);
    const evaluate = evaluator();

    expect(evaluate.endpointEligible(runtime.snapshot(), endpointId).ok).toBe(true);

    // A revival queued ahead of the delete flips the state first.
    await runtime.upsertEndpoint(endpoint(endpointId, "agent-1", "node-historic", "idle", {
      lastActivityAt: NOW - 60 * 60 * 1_000,
    }));
    expect(evaluate.endpointEligible(runtime.snapshot(), endpointId))
      .toEqual({ ok: false, reason: "state-idle" });

    // Still offline but with a fresh heartbeat — the plan's age is stale.
    await runtime.upsertEndpoint(endpoint(endpointId, "agent-1", "node-historic", "offline", {
      lastSeenAt: NOW - 60 * 1_000,
    }));
    expect(evaluate.endpointEligible(runtime.snapshot(), endpointId))
      .toEqual({ ok: false, reason: "recent-activity" });
  });

  test("vetoes an endpoint whose dead node checked in as a live peer mid-sweep", async () => {
    const runtime = createRuntime();
    const { endpointId, nodeId } = await seedStaleRegistration(runtime);
    const evaluate = evaluator();

    expect(evaluate.endpointEligible(runtime.snapshot(), endpointId).ok).toBe(true);

    // The historical node just re-announced — its records are now a live
    // peer's and will be re-advertised, so the sweep must leave them alone.
    await runtime.upsertNode(node(nodeId, NOW - 60 * 1_000));
    expect(evaluate.endpointEligible(runtime.snapshot(), endpointId))
      .toEqual({ ok: false, reason: "live-peer-node" });
  });

  test("re-runs every agent rule against canonical state at write time", async () => {
    const runtime = createRuntime();
    const { agentId } = await seedStaleRegistration(runtime);
    const evaluate = evaluator();

    expect(evaluate.agentEligible(runtime.snapshot(), agentId).ok).toBe(true);

    // A fresh endpoint queued ahead of the delete keeps the agent alive.
    await runtime.upsertEndpoint(endpoint("ep-live", agentId, LOCAL, "idle", {
      lastActivityAt: NOW - 60 * 1_000,
    }));
    expect(evaluate.agentEligible(runtime.snapshot(), agentId))
      .toEqual({ ok: false, reason: "live-endpoint" });
    runtime.deleteEndpoint("ep-live");

    // A non-terminal flight targeting it does too.
    await runtime.commitInvocation(
      invocation(agentId),
      flight("inv-1", agentId, "running"),
    );
    expect(evaluate.agentEligible(runtime.snapshot(), agentId))
      .toEqual({ ok: false, reason: "active-flight" });
  });

  test("vetoes an actor referenced by canonical state even when the plan is stale", async () => {
    const runtime = createRuntime();
    await runtime.upsertActor({ ...actor("sess-1", "session"), createdAt: NOW - 8 * DAY });
    const evaluate = evaluator();

    expect(evaluate.actorEligible(runtime.snapshot(), "sess-1").ok).toBe(true);

    // References that landed after the plan: a message…
    await runtime.commitMessage({ ...message("sess-1") }, []);
    expect(evaluate.actorEligible(runtime.snapshot(), "sess-1"))
      .toEqual({ ok: false, reason: "message-reference" });
  });

  test("vetoes an actor owning a collaboration record and one with a surviving agent row", async () => {
    const runtime = createRuntime();
    await runtime.upsertActor({ ...actor("owner-1"), createdAt: NOW - 8 * DAY });
    const evaluate = evaluator();
    expect(evaluate.actorEligible(runtime.snapshot(), "owner-1").ok).toBe(true);

    await runtime.upsertCollaboration(workItem("owner-1"));
    expect(evaluate.actorEligible(runtime.snapshot(), "owner-1"))
      .toEqual({ ok: false, reason: "collaboration-reference" });

    await seedStaleRegistration(runtime, { agentId: "agent-2" });
    // Deterministic age: the actor stamp is wall-clock at seed time, which
    // the write-time age gate re-checks.
    await runtime.upsertActor({ ...actor("agent-2"), createdAt: NOW - 8 * DAY });
    expect(evaluate.actorEligible(runtime.snapshot(), "agent-2"))
      .toEqual({ ok: false, reason: "agent-row-survives" });
    runtime.deleteAgent("agent-2");
    expect(evaluate.actorEligible(runtime.snapshot(), "agent-2").ok).toBe(true);
  });

  test("vetoes an actor whose endpoint was committed after planning", async () => {
    // Port of the second-pass review repro: a cardless session actor is
    // planned while it has no endpoints; an active endpoint then commits
    // ahead of the actor delete. The evaluator must veto — after the
    // endpoint category ran, a survivor means revival or non-candidate.
    const runtime = createRuntime();
    await runtime.upsertActor({ ...actor("sess-cardless", "session"), createdAt: NOW - 8 * DAY });
    const evaluate = evaluator();
    expect(evaluate.actorEligible(runtime.snapshot(), "sess-cardless").ok).toBe(true);

    await runtime.upsertEndpoint(endpoint("ep-live", "sess-cardless", LOCAL, "active", {
      lastSeenAt: NOW,
    }));
    expect(evaluate.actorEligible(runtime.snapshot(), "sess-cardless"))
      .toEqual({ ok: false, reason: "endpoint-survives:ep-live" });
  });

  test("re-checks the actor age gate at write time, not just at plan time", async () => {
    const runtime = createRuntime();
    // Planned under an old plan, then re-registered recently — a stale plan
    // must not delete a young identity.
    await runtime.upsertActor({ ...actor("sess-young", "session"), createdAt: NOW - DAY });
    expect(evaluator().actorEligible(runtime.snapshot(), "sess-young"))
      .toEqual({ ok: false, reason: "recent-activity" });

    // No stamp anywhere — unknown age is kept, same as the planner.
    await runtime.upsertActor({ ...actor("sess-ageless", "session"), createdAt: NOW - 8 * DAY });
    delete (runtime.peek().actors["sess-ageless"] as RuntimeActorIdentity).createdAt;
    expect(evaluator().actorEligible(runtime.snapshot(), "sess-ageless"))
      .toEqual({ ok: false, reason: "unknown-age" });
  });
});
