// Publishable boundary around @opencode/client@2.0.21.
//
// The runtime values are official generated client/service implementations.
// The local structural types intentionally describe only the stable surface
// consumed by this adapter, keeping the client's effect-typed declaration
// graph out of @openscout/agent-sessions consumers.

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
  version?: string | ((version: string) => boolean);
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

export type SessionInboxDelivery = "steer" | "queue";

export type SessionInboxUserPayload = {
  text: string;
  files?: PromptFile[];
  agents?: Array<{ name: string; mention?: { start: number; end: number; text: string } }>;
  skills?: Array<{ id: string; mention?: { start: number; end: number; text: string } }>;
  metadata?: Record<string, unknown>;
};

export type SessionInboxUser = {
  id: string;
  sessionID: string;
  time: { created: number };
  type: "user";
  payload: SessionInboxUserPayload;
  delivery: SessionInboxDelivery;
};

export type SessionInboxItem =
  | { type: "user"; payload: SessionInboxUserPayload; delivery: SessionInboxDelivery }
  | {
      type: "synthetic";
      payload: { text: string; description?: string; metadata?: Record<string, unknown> };
      delivery: SessionInboxDelivery;
    }
  | { type: "compaction"; payload: Record<string, never>; delivery: SessionInboxDelivery }
  | { type: "move"; payload: Record<string, unknown>; delivery: SessionInboxDelivery };

export type SessionInboxInfo = {
  id: string;
  sessionID: string;
  type: string;
};

export type ServerInfo = {
  version: string;
  pid: number;
};

export type FormOption = { value: string; label: string; description?: string };

type FormFieldBase = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }>;
};

export type FormField =
  | FormFieldBase & { type: "string"; options?: FormOption[]; custom?: boolean; default?: string }
  | FormFieldBase & { type: "number" | "integer"; default?: number }
  | FormFieldBase & { type: "boolean"; default?: boolean }
  | FormFieldBase & { type: "multiselect"; options: FormOption[]; custom?: boolean; default?: string[] }
  | { key: string; type: "external"; url: string; title?: string; description?: string };

export type FormInfo = {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: FormField[];
};

export type FormValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormValue>;

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
  | EventEnvelope<"session.inbox.enqueued", SessionData & {
    inboxID: string;
    item: SessionInboxItem;
  }>
  | EventEnvelope<"session.inbox.delivered" | "session.inbox.cancelled", SessionData & { inboxID: string }>
  | EventEnvelope<"session.inbox.delivery.changed", SessionData & {
    inboxID: string;
    delivery: SessionInboxDelivery;
  }>
  | EventEnvelope<"session.execution.started" | "session.execution.succeeded", SessionData>
  | EventEnvelope<"session.execution.interrupted", SessionData & {
    reason: "user" | "shutdown" | "superseded" | "inactivity";
  }>
  | EventEnvelope<"session.execution.failed", SessionData & { error: StructuredError }>
  | EventEnvelope<"session.idle", SessionData>
  | EventEnvelope<"session.status", SessionData & { status: { type: string } }>
  | EventEnvelope<"session.step.started", AssistantData & {
    agent: string;
    model: ModelRef;
    snapshot?: string;
    started?: number;
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
  | EventEnvelope<"form.created", { form: FormInfo }>
  | EventEnvelope<"form.replied", SessionData & { id: string; answer: FormAnswer }>
  | EventEnvelope<"form.cancelled", SessionData & { id: string }>;

export type OpenCodeClient = {
  server: {
    info(options?: RequestOptions): Promise<ServerInfo>;
  };
  session: {
    active(options?: RequestOptions): Promise<Record<string, { type: "running" }>>;
    create(input?: SessionCreateInput, options?: RequestOptions): Promise<SessionInfo>;
    get(input: SessionGetInput, options?: RequestOptions): Promise<SessionInfo>;
    prompt(input: SessionPromptInput, options?: RequestOptions): Promise<SessionInboxUser>;
    interrupt(
      input: { sessionID: string; resume?: boolean },
      options?: RequestOptions,
    ): Promise<{ interrupted: boolean } | void>;
    wait(input: { sessionID: string }, options?: RequestOptions): Promise<void>;
    inbox: {
      list(input: { sessionID: string }, options?: RequestOptions): Promise<SessionInboxInfo[]>;
      cancel(input: { sessionID: string; inboxID: string }, options?: RequestOptions): Promise<void>;
    };
    form: {
      reply(input: {
        sessionID: string;
        formID: string;
        answer: FormAnswer;
      }, options?: RequestOptions): Promise<void>;
    };
  };
  event: {
    subscribe(options?: RequestOptions): AsyncIterable<OpenCodeEvent>;
  };
  permission: {
    reply(input: {
      sessionID: string;
      requestID: string;
      decision: "once" | "always" | "reject";
      message?: string;
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
