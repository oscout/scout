import { describe, expect, test } from "bun:test";

import type {
  ActorIdentity,
  AgentDefinition,
  CollaborationEvent,
  CollaborationRecord,
  ConversationBinding,
  ConversationDefinition,
  NodeDefinition,
} from "@openscout/protocol";

import type { BrokerDurableCommitOptions } from "./broker-durable-store.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import {
  BrokerMeshBundleService,
  buildMeshBundleEntries,
} from "./broker-mesh-bundle-service.js";

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "openscout",
    name: "Peer",
    brokerUrl: "http://peer.test",
    capabilities: ["broker"],
    registeredAt: 1,
    lastSeenAt: 1,
    ...input,
  };
}

function actor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "operator",
    kind: "person",
    displayName: "Operator",
    handle: "operator",
    labels: [],
    metadata: {},
    ...input,
  };
}

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-1",
    selector: "@agent-1",
    defaultSelector: "@agent-1",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "manual",
    homeNodeId: "node-peer",
    authorityNodeId: "node-peer",
    advertiseScope: "mesh",
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "channel",
    title: "shared",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-peer",
    participantIds: ["operator", "agent-1"],
    metadata: {},
    ...input,
  };
}

function binding(input: Partial<ConversationBinding> = {}): ConversationBinding {
  return {
    id: "binding-1",
    conversationId: "conversation-1",
    actorId: "agent-1",
    role: "participant",
    joinedAt: 1,
    ...input,
  };
}

function workItem(input: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    id: "work-1",
    kind: "work_item",
    state: "working",
    acceptanceState: "none",
    title: "Investigate peer drift",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    conversationId: "conversation-1",
    createdAt: 1,
    updatedAt: 1,
    ...input,
  } as CollaborationRecord;
}

function collaborationEvent(input: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: "event-1",
    recordId: "work-1",
    recordKind: "work_item",
    kind: "progressed",
    actorId: "agent-1",
    at: 2,
    ...input,
  };
}

function createService(input: {
  nodes?: NodeDefinition[];
  agents?: AgentDefinition[];
  records?: CollaborationRecord[];
} = {}) {
  const nodes = new Map((input.nodes ?? []).map((nextNode) => [nextNode.id, nextNode]));
  const agents = new Map((input.agents ?? []).map((nextAgent) => [nextAgent.id, nextAgent]));
  const records = new Map((input.records ?? []).map((record) => [record.id, record]));
  const appliedKinds: BrokerJournalEntry["kind"][] = [];
  const committed: BrokerJournalEntry[][] = [];
  let commitOptions: BrokerDurableCommitOptions | undefined;
  const service = new BrokerMeshBundleService({
    nodeId: "node-local",
    runtime: {
      node: (nodeId) => nodes.get(nodeId),
      agent: (agentId) => agents.get(agentId),
      collaborationRecord: (recordId) => records.get(recordId),
      async upsertNode(nextNode) {
        nodes.set(nextNode.id, nextNode);
        appliedKinds.push("node.upsert");
      },
      async upsertActor() {
        appliedKinds.push("actor.upsert");
      },
      async upsertAgent(nextAgent) {
        agents.set(nextAgent.id, nextAgent);
        appliedKinds.push("agent.upsert");
      },
      async upsertConversation() {
        appliedKinds.push("conversation.upsert");
      },
      async upsertBinding() {
        appliedKinds.push("binding.upsert");
      },
      async upsertCollaboration(record) {
        records.set(record.id, record);
        appliedKinds.push("collaboration.record");
      },
      async appendCollaborationEvent() {
        appliedKinds.push("collaboration.event.record");
      },
    },
    async commitEntries(entries, applyRuntime, options) {
      const normalized = Array.isArray(entries) ? entries : [entries];
      committed.push(normalized);
      commitOptions = options;
      await applyRuntime(normalized);
      return normalized;
    },
  });

  return {
    appliedKinds,
    committed,
    get commitOptions() {
      return commitOptions;
    },
    records,
    nodes,
    service,
  };
}

describe("broker mesh bundle service", () => {
  test("builds deduplicated journal entries for peer bundles", () => {
    const entries = buildMeshBundleEntries({
      originNode: node(),
      actors: [actor(), actor()],
      agents: [agent(), agent()],
      conversation: conversation(),
      bindings: [binding(), binding()],
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "node.upsert",
      "actor.upsert",
      "actor.upsert",
      "agent.upsert",
      "conversation.upsert",
      "binding.upsert",
    ]);
    expect(entries.filter((entry) => entry.kind === "actor.upsert")).toHaveLength(2);
  });

  test("validates, commits, and applies retained mesh bundle entries", async () => {
    const record = workItem();
    const harness = createService();

    const entries = await harness.service.applyBundle({
      originNode: node(),
      actors: [actor()],
      agents: [agent()],
      conversation: conversation(),
      bindings: [binding()],
      collaborationRecord: record,
      collaborationEvent: collaborationEvent(),
    }, { enqueueProjection: false });

    expect(entries).toBe(harness.committed[0]);
    expect(harness.commitOptions).toEqual({ enqueueProjection: false });
    expect(harness.appliedKinds).toEqual([
      "node.upsert",
      "actor.upsert",
      "actor.upsert",
      "agent.upsert",
      "conversation.upsert",
      "binding.upsert",
      "collaboration.record",
      "collaboration.event.record",
    ]);
  });

  test("validates collaboration events against existing records", async () => {
    const { service } = createService({ records: [workItem()] });

    await expect(service.applyBundle({
      originNode: node(),
      actors: [],
      agents: [],
      collaborationEvent: collaborationEvent(),
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "collaboration.event.record" }),
    ]));

    await expect(service.applyBundle({
      originNode: node(),
      actors: [],
      agents: [],
      collaborationEvent: collaborationEvent({ recordId: "missing" }),
    })).rejects.toThrow("unknown collaboration record: missing");
  });

  test("preserves the observer's proven route when a bundle refreshes its origin node", async () => {
    const proven = node({
      brokerUrl: "https://peer.tailnet.example:43110",
      lastSeenAt: 10,
    });
    const harness = createService({ nodes: [proven] });

    await harness.service.applyBundle({
      originNode: node({
        brokerUrl: "https://192.168.1.20:43110",
        lastSeenAt: 20,
      }),
      actors: [],
      agents: [],
    });

    expect(harness.nodes.get("node-peer")).toEqual(expect.objectContaining({
      brokerUrl: "https://peer.tailnet.example:43110",
      lastSeenAt: 20,
    }));
    expect(harness.committed[0]?.[0]).toEqual(expect.objectContaining({
      kind: "node.upsert",
      node: expect.objectContaining({ brokerUrl: "https://peer.tailnet.example:43110" }),
    }));
  });

  test("allows bundles to mention local target agents but rejects local-authority overwrites", async () => {
    const localAgent = agent({
      id: "agent-local",
      homeNodeId: "node-local",
      authorityNodeId: "node-local",
      advertiseScope: "local",
    });
    const { service } = createService({ agents: [localAgent] });

    await expect(service.applyBundle({
      originNode: node(),
      actors: [],
      agents: [localAgent],
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "agent.upsert" }),
    ]));

    await expect(service.applyBundle({
      originNode: node(),
      actors: [],
      agents: [{
        ...localAgent,
        authorityNodeId: "node-peer",
        homeNodeId: "node-peer",
      }],
    })).rejects.toThrow("mesh bundle cannot overwrite local authority for agent agent-local");
  });
});
