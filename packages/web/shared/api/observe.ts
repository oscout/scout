// What an agent is doing, as GET /api/agents/:id/observe serves it: its
// recent events, touched files, usage, and session metadata.

import type { ObservedHarnessTopology } from "@openscout/agent-sessions";

export type ObserveEventKind =
  | "think"
  | "tool"
  | "ask"
  | "message"
  | "note"
  | "system"
  | "boot";

export interface ObserveEvent {
  id: string;
  t: number;
  at?: number;
  kind: ObserveEventKind;
  text: string;
  tool?: string;
  arg?: string;
  diff?: { add: number; del: number; preview: string };
  result?: Record<string, string | number>;
  stream?: string[];
  live?: boolean;
  to?: string;
  answer?: string;
  answerT?: number;
  detail?: string;
}

export interface ObserveFile {
  path: string;
  state: "read" | "created" | "modified";
  touches: number;
  lastT: number;
}

export interface ObserveUsageMeta {
  assistantMessages?: number;
  inputTokens?: number;
  contextInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  contextWindowTokens?: number;
  webSearchRequests?: number;
  webFetchRequests?: number;
  serviceTier?: string;
  speed?: string;
  planType?: string;
}

export interface ObserveSessionMeta {
  adapterType?: string;
  model?: string;
  cwd?: string;
  nodeId?: string;
  hostName?: string;
  sessionStart?: number;
  turnCount?: number;
  externalSessionId?: string;
  threadId?: string;
  threadPath?: string;
  gitBranch?: string;
  cliVersion?: string;
  entrypoint?: string;
  originator?: string;
  source?: string;
  permissionMode?: string;
  approvalPolicy?: string;
  sandbox?: string;
  userType?: string;
  effort?: string;
  modelProvider?: string;
  timezone?: string;
}

export interface ObserveMetadata {
  session?: ObserveSessionMeta;
  usage?: ObserveUsageMeta;
  /** The harness's own agents/tasks graph, when the harness reports one. */
  topology?: ObservedHarnessTopology;
}

/**
 * Recent-activity histogram for the home sparkline. Event density over a fixed
 * trailing window, computed server-side where the full (untruncated) event
 * stream is available. Absent when no event has a resolvable wall-clock time.
 */
export interface ObservePulse {
  /** Width of each bucket in ms. */
  bucketMs: number;
  /** Right edge (exclusive) of the last bucket — the window's "now". */
  endMs: number;
  /** Event count per bucket, oldest → newest; length === bucket count. */
  counts: number[];
}

export interface ObserveData {
  events: ObserveEvent[];
  files: ObserveFile[];
  contextUsage?: number[];
  pulse?: ObservePulse;
  live?: boolean;
  metadata?: ObserveMetadata;
}

export interface ObserveInitiatingAsk {
  task: string;
  requesterId: string;
  requesterName: string;
  requestedAt: number;
  invocationId: string;
  flightId: string;
  conversationId: string | null;
  messageId: string | null;
}

export interface AgentObservePayload {
  agentId: string;
  source: "history" | "live" | "unavailable";
  fidelity: "timestamped" | "synthetic";
  historyPath: string | null;
  sessionId: string | null;
  updatedAt: number;
  initiatingAsk?: ObserveInitiatingAsk | null;
  data: ObserveData;
}
