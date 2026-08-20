import {
  assertValidCollaborationEvent,
  assertValidCollaborationRecord,
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type CollaborationEvent,
  type CollaborationRecord,
  type ConversationBinding,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";

type DurableCommitOptions = {
  enqueueProjection?: boolean;
};

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: DurableCommitOptions,
  ): Promise<BrokerJournalEntry[]>;
};

type RuntimeRecordStore = {
  peek(): {
    endpoints: Record<string, AgentEndpoint>;
  };
  upsertNode(node: NodeDefinition): Promise<void>;
  upsertActor(actor: ActorIdentity): Promise<void>;
  upsertAgent(agent: AgentDefinition): Promise<void>;
  upsertEndpoint(endpoint: AgentEndpoint): Promise<void>;
  refreshEndpointSilently(endpoint: AgentEndpoint): void;
  deleteEndpoint(endpointId: string): void;
  upsertConversation(conversation: ConversationDefinition): Promise<void>;
  upsertBinding(binding: ConversationBinding): Promise<void>;
  upsertCollaboration(record: CollaborationRecord): Promise<void>;
  collaborationRecord(recordId: string): CollaborationRecord | undefined;
  appendCollaborationEvent(event: CollaborationEvent): Promise<void>;
  planMessage(message: MessageRecord, options?: { localOnly?: boolean }): DeliveryIntent[];
  commitMessage(message: MessageRecord, deliveries: DeliveryIntent[]): Promise<void>;
  planInvocation(invocation: InvocationRequest): FlightRecord;
  commitInvocation(invocation: InvocationRequest, flight: FlightRecord): Promise<void>;
};

export type BrokerDurableRecordStoreOptions = {
  runtime: RuntimeRecordStore;
  durableStore: DurableStore;
  knownInvocations: Map<string, InvocationRequest>;
};

function normalizeComparableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeComparableValue(entry)] as const),
  );
}

function comparableEndpointWithoutHeartbeatMetadata(endpoint: AgentEndpoint): unknown {
  const ignoredMetadataKeys = new Set(["lastSeenAt"]);
  if (endpoint.metadata?.source === "scout-channel") {
    ignoredMetadataKeys.add("startedAt");
  }
  const metadata = endpoint.metadata
    ? Object.fromEntries(
        Object.entries(endpoint.metadata)
          .filter(([key]) => !ignoredMetadataKeys.has(key)),
      )
    : undefined;

  return normalizeComparableValue({
    ...endpoint,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

export function isEndpointLastSeenHeartbeat(
  previous: AgentEndpoint | undefined,
  next: AgentEndpoint,
): boolean {
  if (!previous) {
    return false;
  }

  const previousLastSeenAt = previous.metadata?.lastSeenAt;
  const nextLastSeenAt = next.metadata?.lastSeenAt;
  if (
    typeof previousLastSeenAt !== "number"
    || typeof nextLastSeenAt !== "number"
    || !Number.isFinite(previousLastSeenAt)
    || !Number.isFinite(nextLastSeenAt)
    || nextLastSeenAt <= previousLastSeenAt
  ) {
    return false;
  }

  return JSON.stringify(comparableEndpointWithoutHeartbeatMetadata(previous))
    === JSON.stringify(comparableEndpointWithoutHeartbeatMetadata(next));
}

export class BrokerDurableRecordStore {
  constructor(private readonly options: BrokerDurableRecordStoreOptions) {}

  readonly upsertNode = async (node: NodeDefinition): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "node.upsert", node },
        async () => {
          await this.options.runtime.upsertNode(node);
        },
      );
    });
  };

  readonly upsertActor = async (actor: ActorIdentity): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "actor.upsert", actor },
        async () => {
          await this.options.runtime.upsertActor(actor);
        },
      );
    });
  };

  readonly upsertAgent = async (agent: AgentDefinition): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        [
          { kind: "actor.upsert", actor: agent },
          { kind: "agent.upsert", agent },
        ],
        async (entries) => {
          if (entries.some((entry) => entry.kind === "actor.upsert")) {
            await this.options.runtime.upsertActor(agent);
          }
          if (entries.some((entry) => entry.kind === "agent.upsert")) {
            await this.options.runtime.upsertAgent(agent);
          }
        },
      );
    });
  };

  readonly upsertEndpoint = async (endpoint: AgentEndpoint): Promise<void> => {
    const previous = this.options.runtime.peek().endpoints[endpoint.id];
    if (isEndpointLastSeenHeartbeat(previous, endpoint)) {
      this.options.runtime.refreshEndpointSilently(endpoint);
      return;
    }

    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "agent.endpoint.upsert", endpoint },
        async () => {
          await this.options.runtime.upsertEndpoint(endpoint);
        },
      );
    });
  };

  readonly deleteEndpoint = async (endpointId: string): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "agent.endpoint.delete", endpointId },
        async () => {
          this.options.runtime.deleteEndpoint(endpointId);
        },
      );
    });
  };

  readonly upsertConversation = async (conversation: ConversationDefinition): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "conversation.upsert", conversation },
        async () => {
          await this.options.runtime.upsertConversation(conversation);
        },
      );
    });
  };

  readonly upsertBinding = async (binding: ConversationBinding): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "binding.upsert", binding },
        async () => {
          await this.options.runtime.upsertBinding(binding);
        },
      );
    });
  };

  readonly recordCollaboration = async (
    record: CollaborationRecord,
    options: DurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    assertValidCollaborationRecord(record);
    return this.options.durableStore.runWrite(async () => {
      return this.options.durableStore.commitEntries(
        { kind: "collaboration.record", record },
        async () => {
          await this.options.runtime.upsertCollaboration(record);
        },
        options,
      );
    });
  };

  readonly appendCollaborationEvent = async (
    event: CollaborationEvent,
    options: DurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    return this.options.durableStore.runWrite(async () => {
      const record = this.options.runtime.collaborationRecord(event.recordId);
      if (!record) {
        throw new Error(`unknown collaboration record: ${event.recordId}`);
      }
      assertValidCollaborationEvent(event, record);

      return this.options.durableStore.commitEntries(
        { kind: "collaboration.event.record", event },
        async () => {
          await this.options.runtime.appendCollaborationEvent(event);
        },
        options,
      );
    });
  };

  readonly recordMessage = async (
    message: MessageRecord,
    options: {
      localOnly?: boolean;
      enqueueProjection?: boolean;
    } = {},
  ): Promise<{ deliveries: DeliveryIntent[]; entries: BrokerJournalEntry[] }> => {
    return this.options.durableStore.runWrite(async () => {
      const deliveries = this.options.runtime.planMessage(message, {
        localOnly: options.localOnly,
      });
      const entries = await this.options.durableStore.commitEntries(
        [
          { kind: "message.record", message },
          { kind: "deliveries.record", deliveries },
        ],
        async () => {
          await this.options.runtime.commitMessage(message, deliveries);
        },
        { enqueueProjection: options.enqueueProjection },
      );
      return { deliveries, entries };
    });
  };

  readonly recordInvocation = async (
    invocation: InvocationRequest,
    options: {
      flight?: FlightRecord;
      dispatchJob?: BrokerInvocationDispatchJob;
      createDispatchJob?: (flight: FlightRecord) => BrokerInvocationDispatchJob;
      enqueueProjection?: boolean;
    } = {},
  ): Promise<{ flight: FlightRecord; dispatchJob?: BrokerInvocationDispatchJob; entries: BrokerJournalEntry[] }> => {
    return this.options.durableStore.runWrite(async () => {
      const flight = options.flight ?? this.options.runtime.planInvocation(invocation);
      this.options.knownInvocations.set(invocation.id, invocation);
      const dispatchJob = options.dispatchJob ?? options.createDispatchJob?.(flight);
      const entriesToCommit: BrokerJournalEntry[] = [
        { kind: "invocation.record", invocation },
        ...(dispatchJob ? [{ kind: "invocation.dispatch_job.record" as const, job: dispatchJob }] : []),
        { kind: "flight.record", flight },
      ];
      const entries = await this.options.durableStore.commitEntries(
        entriesToCommit,
        async () => {
          await this.options.runtime.commitInvocation(invocation, flight);
        },
        { enqueueProjection: options.enqueueProjection },
      );
      return { flight, dispatchJob, entries };
    });
  };

  readonly recordInvocationDispatchJob = async (
    job: BrokerInvocationDispatchJob,
    options: DurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    return this.options.durableStore.runWrite(async () => {
      return this.options.durableStore.commitEntries(
        { kind: "invocation.dispatch_job.record", job },
        async () => {},
        options,
      );
    });
  };
}
