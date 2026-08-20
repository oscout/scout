import type {
  ScoutAskCommand,
  ScoutAskReceipt,
} from "../../core/broker/ask-types.ts";
import {
  parseScoutRuntimeSpec,
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_REASONING_EFFORTS,
  SCOUT_RESERVED_RUNTIME_PROFILE_IDS,
} from "@openscout/protocol";

const ASK_HARNESS_VALUES = SCOUT_LAUNCHABLE_HARNESSES;
const ASK_WORKSPACE_VALUES = ["same", "new_worktree"] as const;
const ASK_SESSION_VALUES = ["reuse", "new"] as const;
const ASK_PLACEMENT_VALUES = ["background", "foreground"] as const;
const ASK_WORK_ITEM_PRIORITY_VALUES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;
const ASK_WORK_ITEM_ACCEPTANCE_VALUES = [
  "none",
  "pending",
  "accepted",
  "reopened",
] as const;

export const ASK_ROUTE_SOURCE = "scout-control-plane-ask";

type AskWorkItem = NonNullable<ScoutAskCommand["workItem"]>;

export type AskApiBody = {
  senderId?: string;
  to?: string;
  projectPath?: string;
  runtime?: string;
  profile?: string;
  body: string;
  harness?: ScoutAskCommand["harness"];
  model?: string;
  reasoningEffort?: string;
  executionSource?: ScoutAskCommand["executionSource"];
  workspace?: ScoutAskCommand["workspace"];
  session?: ScoutAskCommand["session"];
  placement?: ScoutAskCommand["placement"];
  channel?: string;
  shouldSpeak?: boolean;
  workItem?: AskWorkItem;
};

export type AskApiError = {
  code:
    | "invalid_json"
    | "invalid_body"
    | "invalid_field"
    | "missing_field"
    | "unsupported_value";
  message: string;
  field?: string;
};

export type AskApiErrorResponse = {
  ok: false;
  error: AskApiError;
};

export type AskApiResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      status: 400;
      error: AskApiError;
    };

type BuildScoutAskCommandParams = {
  payload: AskApiBody;
  senderId: string;
  currentDirectory: string;
};

function isOneOf<T extends readonly string[]>(
  values: T,
  value: string | undefined,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok<T>(value: T): AskApiResult<T> {
  return { ok: true, value };
}

export function askApiFailure(
  code: AskApiError["code"],
  message: string,
  field?: string,
): AskApiResult<never> {
  return {
    ok: false,
    status: 400,
    error: field ? { code, message, field } : { code, message },
  };
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): AskApiResult<string> {
  const value = record[field];
  if (typeof value !== "string") {
    return askApiFailure("missing_field", `${field} is required`, field);
  }
  const trimmed = value.trim();
  return trimmed
    ? ok(trimmed)
    : askApiFailure("missing_field", `${field} is required`, field);
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): AskApiResult<string | undefined> {
  const value = record[field];
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "string") {
    return askApiFailure("invalid_field", `${field} must be a string`, field);
  }
  const trimmed = value.trim();
  return ok(trimmed || undefined);
}

function optionalBoolean(
  record: Record<string, unknown>,
  field: string,
): AskApiResult<boolean | undefined> {
  const value = record[field];
  if (value === undefined) {
    return ok(undefined);
  }
  return typeof value === "boolean"
    ? ok(value)
    : askApiFailure("invalid_field", `${field} must be a boolean`, field);
}

function optionalRecord(
  record: Record<string, unknown>,
  field: string,
): AskApiResult<Record<string, unknown> | undefined> {
  const value = record[field];
  if (value === undefined) {
    return ok(undefined);
  }
  return isRecord(value)
    ? ok(value)
    : askApiFailure("invalid_field", `${field} must be an object`, field);
}

function optionalStringArray(
  record: Record<string, unknown>,
  field: string,
): AskApiResult<string[] | undefined> {
  const value = record[field];
  if (value === undefined) {
    return ok(undefined);
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return askApiFailure(
      "invalid_field",
      `${field} must be an array of strings`,
      field,
    );
  }
  const strings = value.map((item) => item.trim()).filter(Boolean);
  return ok(strings.length > 0 ? strings : undefined);
}

function optionalEnum<T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  values: T,
): AskApiResult<T[number] | undefined> {
  const value = record[field];
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== "string") {
    return askApiFailure("invalid_field", `${field} must be a string`, field);
  }
  return isOneOf(values, value)
    ? ok(value)
    : askApiFailure("unsupported_value", `unsupported ${field}`, field);
}

function parseAskWorkItem(
  value: unknown,
): AskApiResult<AskWorkItem | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (!isRecord(value)) {
    return askApiFailure(
      "invalid_field",
      "workItem must be an object",
      "workItem",
    );
  }

  const title = requiredString(value, "title");
  if (!title.ok) {
    return askApiFailure(
      "missing_field",
      "workItem.title is required",
      "workItem.title",
    );
  }

  const summary = optionalString(value, "summary");
  if (!summary.ok) return summary;

  const priority = optionalEnum(
    value,
    "priority",
    ASK_WORK_ITEM_PRIORITY_VALUES,
  );
  if (!priority.ok) return priority;

  const labels = optionalStringArray(value, "labels");
  if (!labels.ok) return labels;

  const parentId = optionalString(value, "parentId");
  if (!parentId.ok) return parentId;

  const acceptanceState = optionalEnum(
    value,
    "acceptanceState",
    ASK_WORK_ITEM_ACCEPTANCE_VALUES,
  );
  if (!acceptanceState.ok) return acceptanceState;

  const metadata = optionalRecord(value, "metadata");
  if (!metadata.ok) return metadata;

  return ok({
    title: title.value,
    ...(summary.value ? { summary: summary.value } : {}),
    ...(priority.value ? { priority: priority.value } : {}),
    ...(labels.value ? { labels: labels.value } : {}),
    ...(parentId.value ? { parentId: parentId.value } : {}),
    ...(acceptanceState.value
      ? { acceptanceState: acceptanceState.value }
      : {}),
    ...(metadata.value ? { metadata: metadata.value } : {}),
  });
}

export function parseAskApiBody(
  value: unknown,
): AskApiResult<AskApiBody> {
  if (!isRecord(value)) {
    return askApiFailure("invalid_body", "JSON body must be an object");
  }

  const senderId = optionalString(value, "senderId");
  if (!senderId.ok) return senderId;

  const to = optionalString(value, "to");
  if (!to.ok) return to;
  const projectPath = optionalString(value, "projectPath");
  if (!projectPath.ok) return projectPath;
  const runtime = optionalString(value, "runtime");
  if (!runtime.ok) return runtime;
  const profile = optionalEnum(value, "profile", SCOUT_RESERVED_RUNTIME_PROFILE_IDS);
  if (!profile.ok) return profile;
  if (!to.value && !projectPath.value && !profile.value && !runtime.value && value.harness === undefined) {
    return askApiFailure(
      "missing_field",
      "to, projectPath, profile, runtime, or harness is required",
      "to",
    );
  }
  if (to.value && (projectPath.value || profile.value)) {
    return askApiFailure(
      "invalid_field",
      "to cannot be combined with projectPath or profile",
      "projectPath",
    );
  }

  const body = requiredString(value, "body");
  if (!body.ok) return body;

  const harness = optionalEnum(value, "harness", ASK_HARNESS_VALUES);
  if (!harness.ok) return harness;
  const model = optionalString(value, "model");
  if (!model.ok) return model;
  const reasoningEffort = optionalEnum(value, "reasoningEffort", SCOUT_REASONING_EFFORTS);
  if (!reasoningEffort.ok) return reasoningEffort;
  const parsedRuntime = runtime.value ? parseScoutRuntimeSpec(runtime.value) : null;
  if (parsedRuntime && !parsedRuntime.ok) {
    return askApiFailure("unsupported_value", `runtime_spec_invalid: ${parsedRuntime.error}`, "runtime");
  }
  const runtimeValue = parsedRuntime?.ok ? parsedRuntime.value : undefined;
  for (const [field, explicit, literal] of [
    ["harness", harness.value, runtimeValue?.harness],
    ["model", model.value, runtimeValue?.model],
    ["reasoningEffort", reasoningEffort.value, runtimeValue?.reasoningEffort],
  ] as const) {
    if (explicit && literal && explicit.toLowerCase() !== literal.toLowerCase()) {
      return askApiFailure(
        "unsupported_value",
        `runtime_conflict: conflicting runtime ${field}: explicit ${explicit} and literal ${literal}`,
        field,
      );
    }
  }

  const workspace = optionalEnum(
    value,
    "workspace",
    ASK_WORKSPACE_VALUES,
  );
  if (!workspace.ok) return workspace;

  const session = optionalEnum(value, "session", ASK_SESSION_VALUES);
  if (!session.ok) return session;

  const placement = optionalEnum(value, "placement", ASK_PLACEMENT_VALUES);
  if (!placement.ok) return placement;

  const channel = optionalString(value, "channel");
  if (!channel.ok) return channel;

  const shouldSpeak = optionalBoolean(value, "shouldSpeak");
  if (!shouldSpeak.ok) return shouldSpeak;

  const workItem = parseAskWorkItem(value.workItem);
  if (!workItem.ok) return workItem;

  return ok({
    ...(senderId.value ? { senderId: senderId.value } : {}),
    ...(to.value ? { to: to.value } : {}),
    ...(projectPath.value ? { projectPath: projectPath.value } : {}),
    ...(runtime.value ? { runtime: runtime.value } : {}),
    ...(profile.value ? { profile: profile.value } : {}),
    body: body.value,
    ...(harness.value ?? runtimeValue?.harness ? { harness: harness.value ?? runtimeValue!.harness } : {}),
    ...(model.value ?? runtimeValue?.model ? { model: model.value ?? runtimeValue!.model } : {}),
    ...(reasoningEffort.value ?? runtimeValue?.reasoningEffort
      ? { reasoningEffort: reasoningEffort.value ?? runtimeValue!.reasoningEffort }
      : {}),
    ...((runtimeValue || harness.value || model.value || reasoningEffort.value) ? {
      executionSource: {
        ...(harness.value ?? runtimeValue?.harness
          ? { harness: harness.value ? "flag" as const : "literal" as const }
          : {}),
        ...(model.value ?? runtimeValue?.model
          ? { model: model.value ? "flag" as const : "literal" as const }
          : {}),
        ...(reasoningEffort.value ?? runtimeValue?.reasoningEffort
          ? { reasoningEffort: reasoningEffort.value ? "flag" as const : "literal" as const }
          : {}),
      },
    } : {}),
    ...(workspace.value ? { workspace: workspace.value } : {}),
    ...(session.value ? { session: session.value } : {}),
    ...(placement.value ? { placement: placement.value } : {}),
    ...(channel.value ? { channel: channel.value } : {}),
    ...(shouldSpeak.value !== undefined ? { shouldSpeak: shouldSpeak.value } : {}),
    ...(workItem.value ? { workItem: workItem.value } : {}),
  });
}

export function buildScoutAskCommand({
  payload,
  senderId,
  currentDirectory,
}: BuildScoutAskCommandParams): ScoutAskCommand {
  const target = payload.to
    ? { to: payload.to }
    : payload.profile
      ? {
          runtimeProfile: payload.profile,
          ...(payload.projectPath ? { projectPath: payload.projectPath } : {}),
        }
    : payload.projectPath
      ? { projectPath: payload.projectPath }
      : {};
  return {
    senderId,
    ...target,
    body: payload.body,
    harness: payload.harness,
    model: payload.model,
    reasoningEffort: payload.reasoningEffort,
    runtimeLiteral: payload.runtime,
    executionSource: payload.executionSource,
    workspace: payload.workspace,
    session: payload.session,
    ...(payload.placement ? { placement: payload.placement } : {}),
    channel: payload.channel,
    shouldSpeak: payload.shouldSpeak,
    workItem: payload.workItem,
    // The HTTP surface returns a durable receipt and the web app observes the
    // conversation directly; it does not need a second endpoint notification.
    replyMode: "none",
    currentDirectory,
    source: ASK_ROUTE_SOURCE,
  };
}

export function askReceiptStatus(
  receipt: ScoutAskReceipt,
): 202 | 409 | 422 | 502 {
  if (receipt.ok) {
    return 202;
  }
  if (receipt.error?.code === "broker_unreachable") {
    return 502;
  }
  return receipt.state === "ambiguous" ? 409 : 422;
}
