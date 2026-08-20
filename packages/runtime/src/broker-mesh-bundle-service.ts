import {
  assertValidCollaborationEvent,
  assertValidCollaborationRecord,
  type ActorIdentity,
  type AgentDefinition,
  type CollaborationEvent,
  type CollaborationRecord,
  type ConversationBinding,
  type ConversationDefinition,
  type NodeDefinition,
} from "@openscout/protocol";

import type { BrokerDurableCommitOptions } from "./broker-durable-store.js";
import type { BrokerJournalEntry } from "./broker-journal.js";

export type BrokerMeshBundle = {
  originNode: NodeDefinition;
  actors: ActorIdentity[];
  agents: AgentDefinition[];
  conversation?: ConversationDefinition;
  bindings?: ConversationBinding[];
  collaborationRecord?: CollaborationRecord;
  collaborationEvent?: CollaborationEvent;
};

export type BrokerMeshBundleRuntime = {
  node(nodeId: string): NodeDefinition | undefined;
  agent(agentId: string): AgentDefinition | undefined;
  collaborationRecord(recordId: string): CollaborationRecord | undefined;
  upsertNode(node: NodeDefinition): Promise<void>;
  upsertActor(actor: ActorIdentity): Promise<void>;
  upsertAgent(agent: AgentDefinition): Promise<void>;
  upsertConversation(conversation: ConversationDefinition): Promise<void>;
  upsertBinding(binding: ConversationBinding): Promise<void>;
  upsertCollaboration(record: CollaborationRecord): Promise<void>;
  appendCollaborationEvent(event: CollaborationEvent): Promise<void>;
};

export type BrokerMeshBundleServiceDeps = {
  nodeId: string;
  runtime: BrokerMeshBundleRuntime;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: BrokerDurableCommitOptions,
  ) => Promise<BrokerJournalEntry[]>;
};

export function buildMeshBundleEntries(bundle: BrokerMeshBundle): BrokerJournalEntry[] {
  const entries: BrokerJournalEntry[] = [
    { kind: "node.upsert", node: bundle.originNode },
  ];
  const actorIds = new Set<string>();
  const agentIds = new Set<string>();
  const bindingIds = new Set<string>();

  for (const actor of bundle.actors) {
    if (actorIds.has(actor.id)) {
      continue;
    }
    actorIds.add(actor.id);
    entries.push({ kind: "actor.upsert", actor });
  }

  for (const agent of bundle.agents) {
    if (agentIds.has(agent.id)) {
      continue;
    }
    agentIds.add(agent.id);
    if (!actorIds.has(agent.id)) {
      actorIds.add(agent.id);
      entries.push({ kind: "actor.upsert", actor: agent });
    }
    entries.push({ kind: "agent.upsert", agent });
  }

  if (bundle.conversation) {
    entries.push({ kind: "conversation.upsert", conversation: bundle.conversation });
  }

  for (const binding of bundle.bindings ?? []) {
    if (bindingIds.has(binding.id)) {
      continue;
    }
    bindingIds.add(binding.id);
    entries.push({ kind: "binding.upsert", binding });
  }

  if (bundle.collaborationRecord) {
    entries.push({ kind: "collaboration.record", record: bundle.collaborationRecord });
  }

  if (bundle.collaborationEvent) {
    entries.push({ kind: "collaboration.event.record", event: bundle.collaborationEvent });
  }

  return entries;
}

export class BrokerMeshBundleService {
  constructor(private readonly deps: BrokerMeshBundleServiceDeps) {}

  readonly applyBundle = async (
    bundle: BrokerMeshBundle,
    options: BrokerDurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    const existingOriginNode = this.deps.runtime.node(bundle.originNode.id);
    // brokerUrl is observer-local routing evidence. A peer's bundle may
    // refresh its signed card and heartbeat, but its self-preferred address
    // must not replace the endpoint this observer successfully discovered.
    const routedBundle = existingOriginNode?.brokerUrl
      ? {
          ...bundle,
          originNode: {
            ...bundle.originNode,
            brokerUrl: existingOriginNode.brokerUrl,
          },
        }
      : bundle;
    this.validateBundle(routedBundle);
    const entries = buildMeshBundleEntries(routedBundle);
    return this.deps.commitEntries(
      entries,
      async (retainedEntries) => {
        await this.applyRetainedEntries(retainedEntries);
      },
      options,
    );
  };

  private validateBundle(bundle: BrokerMeshBundle): void {
    for (const agent of bundle.agents) {
      const existing = this.deps.runtime.agent(agent.id);
      if (
        existing?.authorityNodeId === this.deps.nodeId
        && agent.authorityNodeId !== this.deps.nodeId
      ) {
        throw new Error(`mesh bundle cannot overwrite local authority for agent ${agent.id}`);
      }
    }
    if (bundle.collaborationRecord) {
      assertValidCollaborationRecord(bundle.collaborationRecord);
    }
    if (bundle.collaborationEvent) {
      const record = bundle.collaborationRecord
        ?? this.deps.runtime.collaborationRecord(bundle.collaborationEvent.recordId);
      if (!record) {
        throw new Error(`unknown collaboration record: ${bundle.collaborationEvent.recordId}`);
      }
      assertValidCollaborationEvent(bundle.collaborationEvent, record);
    }
  }

  private async applyRetainedEntries(entries: BrokerJournalEntry[]): Promise<void> {
    for (const entry of entries) {
      switch (entry.kind) {
        case "node.upsert":
          await this.deps.runtime.upsertNode(entry.node);
          break;
        case "actor.upsert":
          await this.deps.runtime.upsertActor(entry.actor);
          break;
        case "agent.upsert":
          await this.deps.runtime.upsertAgent(entry.agent);
          break;
        case "conversation.upsert":
          await this.deps.runtime.upsertConversation(entry.conversation);
          break;
        case "binding.upsert":
          await this.deps.runtime.upsertBinding(entry.binding);
          break;
        case "collaboration.record":
          await this.deps.runtime.upsertCollaboration(entry.record);
          break;
        case "collaboration.event.record":
          await this.deps.runtime.appendCollaborationEvent(entry.event);
          break;
        default:
          break;
      }
    }
  }
}
