import type {
  FlightRecord,
  InvocationRequest,
} from "@openscout/protocol";

import {
  isInvocationDispatchJobDue,
  type BrokerInvocationDispatchJob,
} from "./broker-dispatch-job.js";

type DispatchRecoverySnapshot = {
  flights: Record<string, FlightRecord>;
};

export type BrokerDispatchRecoveryResult = {
  considered: number;
  dispatched: number;
  skippedActive: number;
  skippedMissingInvocation: number;
};

export type BrokerDispatchRecoveryServiceDeps = {
  runtimeSnapshot: () => DispatchRecoverySnapshot;
  dispatchJobs: () => BrokerInvocationDispatchJob[];
  invocationFor: (invocationId: string) => InvocationRequest | undefined;
  isInvocationActive: (invocationId: string) => boolean;
  runDispatchJob: (job: BrokerInvocationDispatchJob, invocation?: InvocationRequest) => Promise<void>;
  dispatchAcceptedInvocation?: (invocation: InvocationRequest) => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
};

export class BrokerDispatchRecoveryService {
  readonly #recoveringInvocationIds = new Set<string>();
  readonly #deferredInvocations = new Map<string, number>();

  constructor(private readonly deps: BrokerDispatchRecoveryServiceDeps) {}

  /**
   * Suppress recovery redispatch for one invocation until `notBeforeTs`.
   * Used by thread_held_externally parks: restoring the endpoint's online
   * state fires this service via the persist hook, and without the deferral
   * the parked flight would redispatch (and re-fail) in a hot loop.
   */
  deferInvocation(invocationId: string, notBeforeTs: number): void {
    this.#deferredInvocations.set(invocationId, notBeforeTs);
  }

  #isDeferred(invocationId: string, now: number): boolean {
    const notBefore = this.#deferredInvocations.get(invocationId);
    if (notBefore === undefined) return false;
    if (now >= notBefore) {
      this.#deferredInvocations.delete(invocationId);
      return false;
    }
    return true;
  }

  async recoverQueuedFlights(input: {
    reason: string;
    agentId?: string;
  }): Promise<BrokerDispatchRecoveryResult> {
    const now = this.deps.now?.() ?? Date.now();
    const jobs = this.deps.dispatchJobs()
      .filter((job) => isInvocationDispatchJobDue(job, now, { includeRunning: true }))
      .filter((job) => !input.agentId || job.targetAgentId === input.agentId)
      .filter((job) => !this.#isDeferred(job.invocationId, now))
      .sort((left, right) => left.createdAt - right.createdAt);
    const jobInvocationIds = new Set(jobs.map((job) => job.invocationId));
    const queued = Object.values(this.deps.runtimeSnapshot().flights)
      .filter((flight) => flight.state === "queued" || flight.state === "waking")
      .filter((flight) => !input.agentId || flight.targetAgentId === input.agentId)
      .filter((flight) => !jobInvocationIds.has(flight.invocationId))
      .filter((flight) => !this.#isDeferred(flight.invocationId, now))
      .sort((left, right) => flightSortTime(left) - flightSortTime(right));
    const result: BrokerDispatchRecoveryResult = {
      considered: jobs.length + queued.length,
      dispatched: 0,
      skippedActive: 0,
      skippedMissingInvocation: 0,
    };

    for (const job of jobs) {
      const invocation = this.deps.invocationFor(job.invocationId);
      if (!invocation) {
        result.skippedMissingInvocation += 1;
        this.deps.warn?.(
          `[openscout-runtime] dispatch job ${job.id} has no invocation ${job.invocationId}; recovery skipped`,
        );
        continue;
      }
      if (
        this.deps.isInvocationActive(invocation.id)
        || this.#recoveringInvocationIds.has(invocation.id)
      ) {
        result.skippedActive += 1;
        continue;
      }

      this.#recoveringInvocationIds.add(invocation.id);
      try {
        this.deps.log?.(
          `[openscout-runtime] recovering dispatch job ${job.id} for ${job.targetAgentId} (${input.reason})`,
        );
        await this.deps.runDispatchJob(job, invocation);
        result.dispatched += 1;
      } finally {
        this.#recoveringInvocationIds.delete(invocation.id);
      }
    }

    for (const flight of queued) {
      const invocation = this.deps.invocationFor(flight.invocationId);
      if (!invocation) {
        result.skippedMissingInvocation += 1;
        this.deps.warn?.(
          `[openscout-runtime] queued flight ${flight.id} has no invocation ${flight.invocationId}; recovery skipped`,
        );
        continue;
      }
      if (
        this.deps.isInvocationActive(invocation.id)
        || this.#recoveringInvocationIds.has(invocation.id)
      ) {
        result.skippedActive += 1;
        continue;
      }
      if (!this.deps.dispatchAcceptedInvocation) {
        continue;
      }

      this.#recoveringInvocationIds.add(invocation.id);
      try {
        this.deps.log?.(
          `[openscout-runtime] recovering legacy queued flight ${flight.id} for ${flight.targetAgentId} (${input.reason})`,
        );
        await this.deps.dispatchAcceptedInvocation(invocation);
        result.dispatched += 1;
      } finally {
        this.#recoveringInvocationIds.delete(invocation.id);
      }
    }

    return result;
  }
}

function flightSortTime(flight: FlightRecord): number {
  return flight.startedAt ?? flight.completedAt ?? 0;
}
