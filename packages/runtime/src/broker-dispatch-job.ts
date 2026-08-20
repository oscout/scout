import type { FlightRecord, InvocationRequest } from "@openscout/protocol";

export type BrokerInvocationDispatchJobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type BrokerInvocationDispatchJob = {
  id: string;
  invocationId: string;
  flightId: string;
  targetAgentId: string;
  state: BrokerInvocationDispatchJobState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  completedAt?: number;
};

const TERMINAL_DISPATCH_JOB_STATES = new Set<BrokerInvocationDispatchJobState>([
  "completed",
  "failed",
  "cancelled",
]);

export function invocationDispatchJobId(invocationId: string): string {
  return `dispatch-${invocationId}`;
}

export function isTerminalInvocationDispatchJobState(
  state: BrokerInvocationDispatchJobState,
): boolean {
  return TERMINAL_DISPATCH_JOB_STATES.has(state);
}

export function createInvocationDispatchJob(
  invocation: InvocationRequest,
  flight: FlightRecord,
  now: number,
): BrokerInvocationDispatchJob {
  return {
    id: invocationDispatchJobId(invocation.id),
    invocationId: invocation.id,
    flightId: flight.id,
    targetAgentId: invocation.targetAgentId,
    state: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function isInvocationDispatchJobDue(
  job: BrokerInvocationDispatchJob,
  now: number,
  options: { includeRunning?: boolean } = {},
): boolean {
  if (job.state === "pending") {
    return true;
  }
  if (job.state !== "running" || !options.includeRunning) {
    return false;
  }
  return job.leaseExpiresAt === undefined || job.leaseExpiresAt <= now;
}
