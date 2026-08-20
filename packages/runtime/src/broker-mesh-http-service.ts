import type {
  AgentDefinition,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import type { BrokerDurableCommitOptions } from "./broker-durable-store.js";
import {
  createInvocationDispatchJob,
  type BrokerInvocationDispatchJob,
} from "./broker-dispatch-job.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import type {
  MeshCollaborationEventBundle,
  MeshCollaborationRecordBundle,
  MeshInvocationBundle,
  MeshMessageBundle,
} from "./mesh-forwarding.js";

export type BrokerMeshHttpRuntime = {
  message(messageId: string): MessageRecord | undefined;
  planMessage(message: MessageRecord, options?: { localOnly?: boolean }): DeliveryIntent[];
  commitMessage(message: MessageRecord, deliveries: DeliveryIntent[]): Promise<void>;
  agent(agentId: string): AgentDefinition | undefined;
  flightForInvocation(invocationId: string): FlightRecord | undefined;
  planInvocation(invocation: InvocationRequest): FlightRecord;
  commitInvocation(invocation: InvocationRequest, flight: FlightRecord): Promise<void>;
  collaborationRecord(recordId: string): unknown;
};

export type BrokerMeshHttpServiceDeps = {
  nodeId: string;
  runtime: BrokerMeshHttpRuntime;
  runDurableWrite: <T>(work: () => Promise<T>) => Promise<T>;
  applyMeshBundle: (
    bundle: MeshMessageBundle | MeshInvocationBundle | MeshCollaborationRecordBundle | MeshCollaborationEventBundle,
    options?: BrokerDurableCommitOptions,
  ) => Promise<BrokerJournalEntry[]>;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: BrokerDurableCommitOptions,
  ) => Promise<BrokerJournalEntry[]>;
  applyProjectedEntries: (entries: BrokerJournalEntry[]) => Promise<void>;
  rememberInvocation: (invocation: InvocationRequest) => void;
  runDispatchJob?: (
    job: BrokerInvocationDispatchJob,
    invocation: InvocationRequest,
  ) => Promise<void>;
  warn?: (message: string, detail?: unknown) => void;
  now?: () => number;
};

export type BrokerMeshHttpResult = {
  status: number;
  body: unknown;
};

export class BrokerMeshHttpService {
  constructor(private readonly deps: BrokerMeshHttpServiceDeps) {}

  readonly receiveMessageBundle = async (bundle: MeshMessageBundle): Promise<BrokerMeshHttpResult> => {
    const result = await this.deps.runDurableWrite(async () => {
      const bundleEntries = await this.deps.applyMeshBundle(bundle, {
        enqueueProjection: false,
      });

      if (bundle.conversation.authorityNodeId !== this.deps.nodeId) {
        return {
          kind: "not_authority" as const,
          bundleEntries,
          authorityNodeId: bundle.conversation.authorityNodeId,
        };
      }

      if (this.deps.runtime.message(bundle.message.id)) {
        return {
          kind: "duplicate" as const,
          bundleEntries,
          messageEntries: [] as BrokerJournalEntry[],
          deliveries: [] as DeliveryIntent[],
        };
      }

      const deliveries = this.deps.runtime.planMessage(bundle.message, { localOnly: true });
      const messageEntries = await this.deps.commitEntries(
        [
          { kind: "message.record", message: bundle.message },
          { kind: "deliveries.record", deliveries },
        ],
        async () => {
          await this.deps.runtime.commitMessage(bundle.message, deliveries);
        },
        { enqueueProjection: false },
      );

      return {
        kind: "ok" as const,
        bundleEntries,
        messageEntries,
        deliveries,
      };
    });

    if (result.kind === "not_authority") {
      await this.deps.applyProjectedEntries(result.bundleEntries);
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `conversation ${bundle.conversation.id} is owned by ${result.authorityNodeId}`,
        },
      };
    }

    await this.deps.applyProjectedEntries([...result.bundleEntries, ...result.messageEntries]);
    return {
      status: 200,
      body: result.kind === "duplicate"
        ? { ok: true, duplicate: true }
        : { ok: true, deliveries: result.deliveries },
    };
  };

  readonly receiveInvocationBundle = async (bundle: MeshInvocationBundle): Promise<BrokerMeshHttpResult> => {
    const result = await this.deps.runDurableWrite(async () => {
      const bundleEntries = await this.deps.applyMeshBundle(bundle, {
        enqueueProjection: false,
      });

      const targetAgent = this.deps.runtime.agent(bundle.invocation.targetAgentId);
      if (!targetAgent) {
        throw new Error(`unknown target agent ${bundle.invocation.targetAgentId}`);
      }
      if (targetAgent.authorityNodeId !== this.deps.nodeId) {
        return {
          kind: "not_authority" as const,
          bundleEntries,
          targetAgent,
        };
      }

      const existing = this.deps.runtime.flightForInvocation(bundle.invocation.id);
      if (existing) {
        return {
          kind: "duplicate" as const,
          bundleEntries,
          flight: existing,
        };
      }

      const flight = this.deps.runtime.planInvocation(bundle.invocation);
      const dispatchJob = createInvocationDispatchJob(
        bundle.invocation,
        flight,
        this.now(),
      );
      this.deps.rememberInvocation(bundle.invocation);
      const invocationEntries = await this.deps.commitEntries(
        [
          { kind: "invocation.record", invocation: bundle.invocation },
          { kind: "invocation.dispatch_job.record", job: dispatchJob },
          { kind: "flight.record", flight },
        ],
        async () => {
          await this.deps.runtime.commitInvocation(bundle.invocation, flight);
        },
        { enqueueProjection: false },
      );

      return {
        kind: "ok" as const,
        bundleEntries,
        invocationEntries,
        dispatchJob,
        flight,
      };
    });

    if (result.kind === "not_authority") {
      await this.deps.applyProjectedEntries(result.bundleEntries);
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `agent ${result.targetAgent.id} is owned by ${result.targetAgent.authorityNodeId}`,
        },
      };
    }

    if (result.kind === "duplicate") {
      await this.deps.applyProjectedEntries(result.bundleEntries);
      return {
        status: 200,
        body: { ok: true, duplicate: true, flight: result.flight },
      };
    }

    await this.deps.applyProjectedEntries([...result.bundleEntries, ...result.invocationEntries]);
    if (this.deps.runDispatchJob) {
      this.deps.runDispatchJob(result.dispatchJob, bundle.invocation).catch((error) => {
        this.deps.warn?.(
          `[openscout-runtime] mesh dispatch job failed for invocation ${bundle.invocation.id}`,
          error,
        );
      });
    }
    return {
      status: 200,
      body: { ok: true, flight: result.flight },
    };
  };

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  readonly receiveCollaborationRecordBundle = async (
    bundle: MeshCollaborationRecordBundle,
  ): Promise<BrokerMeshHttpResult> => {
    const result = await this.deps.runDurableWrite(async () => {
      if (bundle.conversation && bundle.conversation.authorityNodeId !== this.deps.nodeId) {
        return {
          kind: "not_authority" as const,
          authorityNodeId: bundle.conversation.authorityNodeId,
          entries: [] as BrokerJournalEntry[],
          existing: null as unknown,
        };
      }

      const existing = this.deps.runtime.collaborationRecord(bundle.record.id);
      const entries = await this.deps.applyMeshBundle(bundle, {
        enqueueProjection: false,
      });
      return { kind: "ok" as const, existing, entries };
    });

    if (result.kind === "not_authority") {
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `conversation ${bundle.conversation?.id ?? bundle.record.conversationId ?? bundle.record.id} is owned by ${result.authorityNodeId}`,
        },
      };
    }

    await this.deps.applyProjectedEntries(result.entries);
    return {
      status: 200,
      body: result.existing ? { ok: true, duplicate: true } : { ok: true },
    };
  };

  readonly receiveCollaborationEventBundle = async (
    bundle: MeshCollaborationEventBundle,
  ): Promise<BrokerMeshHttpResult> => {
    if (bundle.conversation && bundle.conversation.authorityNodeId !== this.deps.nodeId) {
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `conversation ${bundle.conversation.id} is owned by ${bundle.conversation.authorityNodeId}`,
        },
      };
    }

    const entries = await this.deps.runDurableWrite(async () => this.deps.applyMeshBundle(bundle, {
      enqueueProjection: false,
    }));
    await this.deps.applyProjectedEntries(entries);
    return {
      status: 200,
      body: { ok: true },
    };
  };
}
