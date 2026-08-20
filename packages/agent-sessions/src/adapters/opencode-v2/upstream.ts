// Publishable boundary around @opencode-ai/client@0.0.0-next-17226.
//
// The runtime values are official generated client/service implementations.
// The local structural types intentionally describe only the stable surface
// consumed by this adapter, preventing the beta package's broken extensionless
// NodeNext declarations from leaking into @openscout/agent-sessions consumers.

import {
  OpenCode as OfficialOpenCode,
  Service as OfficialService,
} from "./upstream-runtime.mjs";

export type Endpoint = {
  url: string;
  auth?: {
    type: "basic";
    username: string;
    password: string;
  };
};

export type DiscoverOptions = {
  file?: string;
  version?: string;
};

export type EnsureOptions = DiscoverOptions & {
  command?: readonly string[];
  onStart?: (reason: "missing" | "version-mismatch", previousVersion?: string) => void;
};

export type RequestOptions = {
  signal?: AbortSignal;
  headers?: HeadersInit;
};

export type OpenCodeClientOptions = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: RequestInit["headers"];
};

export type ModelRef = {
  id: string;
  providerID: string;
  variant?: string;
};

export type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type SessionInfo = {
  id: string;
  projectID: string;
  parentID?: string;
  agent?: string;
  model?: ModelRef;
  cost: number;
  tokens: TokenUsage;
  time: { created: number; updated: number; archived?: number };
  title?: string;
  location: { directory: string; workspaceID?: string };
  subpath?: string;
};

export type PromptFile = {
  uri: string;
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
};

export type SessionCreateInput = {
  id?: string | null;
  title?: string | null;
  agent?: string | null;
  model?: ModelRef | null;
  location?: { directory: string; workspaceID?: string } | null;
};

export type SessionGetInput = { sessionID: string };

export type SessionPromptInput = {
  sessionID: string;
  id?: string | null;
  text: string;
  files?: readonly PromptFile[];
  agents?: readonly { name: string; mention?: { start: number; end: number; text: string } }[];
  skills?: readonly { id: string; mention?: { start: number; end: number; text: string } }[];
  metadata?: Record<string, unknown>;
  delivery?: "steer" | "queue" | null;
  resume?: boolean | null;
};

export type SessionPendingUser = {
  id: string;
  sessionID: string;
  timeCreated: number;
  type: "user";
  data: {
    text: string;
    files?: PromptFile[];
    agents?: Array<{ name: string; mention?: { start: number; end: number; text: string } }>;
    skills?: Array<{ id: string; mention?: { start: number; end: number; text: string } }>;
    metadata?: Record<string, unknown>;
  };
  delivery: "steer" | "queue";
};

export type SessionPendingMessage =
  | {
      type: "user";
      data: SessionPendingUser["data"];
      delivery: "steer" | "queue";
    }
  | {
      type: "synthetic";
      data: {
        text: string;
        description?: string;
        metadata?: Record<string, unknown>;
      };
      delivery: "steer" | "queue";
    };

export type SessionPendingInfo = {
  id: string;
  sessionID: string;
  type: string;
};

type EventEnvelope<Type extends string, Data> = {
  id: string;
  created?: number;
  metadata?: Record<string, unknown>;
  type: Type;
  durable?: { aggregateID: string; seq: number; version: 1 | 2 };
  location?: { directory: string; workspaceID?: string };
  data: Data;
};

type SessionData = { sessionID: string };
type AssistantData = SessionData & { assistantMessageID: string };
type StreamData = AssistantData & { ordinal: number };
type ToolData = AssistantData & { id: string };
type StructuredError = { type: string; message: string; status?: number };
type ToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string };

export type OpenCodeEvent =
  | EventEnvelope<"server.connected", Record<string, never>>
  | EventEnvelope<"session.input.admitted", SessionData & {
    inputID: string;
    input: SessionPendingMessage;
  }>
  | EventEnvelope<
    "session.input.promoted" | "session.input.queued" | "session.input.steered" | "session.input.cancelled",
    SessionData & { inputID: string }
  >
  | EventEnvelope<"session.execution.started" | "session.execution.succeeded", SessionData>
  | EventEnvelope<"session.execution.interrupted", SessionData & {
    reason: "user" | "shutdown" | "superseded";
  }>
  | EventEnvelope<"session.execution.failed", SessionData & { error: StructuredError }>
  | EventEnvelope<"session.idle", SessionData>
  | EventEnvelope<"session.status", SessionData & { status: { type: string } }>
  | EventEnvelope<"session.step.started", AssistantData & {
    agent: string;
    model: ModelRef;
    snapshot?: string;
  }>
  | EventEnvelope<"session.step.ended", AssistantData & {
    finish: string;
    cost: number;
    tokens: TokenUsage;
    snapshot?: string;
    files?: string[];
  }>
  | EventEnvelope<"session.step.failed", AssistantData & {
    error: StructuredError;
    cost?: number;
    tokens?: TokenUsage;
    snapshot?: string;
    files?: string[];
  }>
  | EventEnvelope<"session.usage.updated", SessionData & { cost: number; tokens: TokenUsage }>
  | EventEnvelope<"session.text.started" | "session.reasoning.started", StreamData & {
    state?: Record<string, unknown>;
  }>
  | EventEnvelope<"session.text.delta" | "session.reasoning.delta", StreamData & { delta: string }>
  | EventEnvelope<"session.text.ended" | "session.reasoning.ended", StreamData & {
    text: string;
    state?: Record<string, unknown>;
  }>
  | EventEnvelope<"session.tool.input.started", ToolData & { name: string }>
  | EventEnvelope<"session.tool.input.delta", ToolData & { delta: string }>
  | EventEnvelope<"session.tool.input.ended", ToolData & { text: string }>
  | EventEnvelope<"session.tool.called", ToolData & {
    input: Record<string, unknown>;
    executed: boolean;
    state?: Record<string, unknown>;
  }>
  | EventEnvelope<"session.tool.progress", ToolData & { metadata: Record<string, unknown> }>
  | EventEnvelope<"session.tool.success", ToolData & {
    content: ToolContent[];
    metadata?: Record<string, unknown>;
    executed: boolean;
    resultState?: Record<string, unknown>;
  }>
  | EventEnvelope<"session.tool.failed", ToolData & {
    error: StructuredError;
    content?: ToolContent[];
    metadata?: Record<string, unknown>;
    executed: boolean;
    resultState?: Record<string, unknown>;
  }>
  | EventEnvelope<"permission.asked", SessionData & {
    id: string;
    action: string;
    resources: string[];
    save?: string[];
    metadata?: Record<string, unknown>;
    source?: { type: "tool"; messageID: string; id: string };
  }>
  | EventEnvelope<"permission.replied", SessionData & {
    requestID: string;
    reply: "once" | "always" | "reject";
  }>
  | EventEnvelope<"question.asked", SessionData & {
    id: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
    tool?: { messageID: string; id: string };
  }>
  | EventEnvelope<"question.replied", SessionData & {
    requestID: string;
    answers: string[][];
  }>
  | EventEnvelope<"question.rejected", SessionData & { requestID: string }>;

export type OpenCodeClient = {
  health: {
    get(options?: RequestOptions): Promise<{ healthy: true; version: string; pid: number }>;
  };
  session: {
    active(options?: RequestOptions): Promise<Record<string, { type: "running" }>>;
    create(input?: SessionCreateInput, options?: RequestOptions): Promise<SessionInfo>;
    get(input: SessionGetInput, options?: RequestOptions): Promise<SessionInfo>;
    prompt(input: SessionPromptInput, options?: RequestOptions): Promise<SessionPendingUser>;
    interrupt(input: { sessionID: string }, options?: RequestOptions): Promise<void>;
    wait(input: { sessionID: string }, options?: RequestOptions): Promise<void>;
    pending: {
      list(input: { sessionID: string }, options?: RequestOptions): Promise<SessionPendingInfo[]>;
      cancel(input: { sessionID: string; inputID: string }, options?: RequestOptions): Promise<void>;
    };
  };
  event: {
    subscribe(options?: RequestOptions): AsyncIterable<OpenCodeEvent>;
  };
  permission: {
    reply(input: {
      sessionID: string;
      requestID: string;
      reply: "once" | "always" | "reject";
      message?: string;
    }, options?: RequestOptions): Promise<void>;
  };
  question: {
    reply(input: {
      sessionID: string;
      requestID: string;
      answers: readonly (readonly string[])[];
    }, options?: RequestOptions): Promise<void>;
  };
};

export type ServiceFacade = {
  discover(options?: DiscoverOptions): Promise<Endpoint | undefined>;
  ensure(options?: EnsureOptions): Promise<Endpoint>;
  headers(endpoint: Endpoint): { authorization: string } | undefined;
};

export const OpenCode = OfficialOpenCode as {
  make(options: OpenCodeClientOptions): OpenCodeClient;
};

export const Service = OfficialService as ServiceFacade;
