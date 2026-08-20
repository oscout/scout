import { basename, resolve } from "node:path";

import {
  parseScoutComposerRouteTarget,
  type ScoutRouteTarget,
} from "@openscout/protocol";
import { findNearestProjectRoot } from "@openscout/runtime/setup";

import {
  deliverScoutAsk,
  type ScoutAskResult,
  type ScoutFlightRecord,
} from "./service.ts";
import type {
  ScoutAskCommand,
  ScoutAskNextCall,
  ScoutAskReceipt,
  ScoutAskSenderContext,
} from "./ask-types.ts";

export type ScoutAskHandler = (
  command: ScoutAskCommand,
) => Promise<ScoutAskReceipt>;

function compactSenderContext(
  input: ScoutAskSenderContext,
): ScoutAskSenderContext {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== ""),
  ) as ScoutAskSenderContext;
}

export async function buildScoutAskSenderContext(input: {
  senderId: string;
  currentDirectory: string;
  lastTargetId?: string;
}): Promise<ScoutAskSenderContext> {
  const projectRoot = await findNearestProjectRoot(input.currentDirectory);
  return compactSenderContext({
    agentId: input.senderId,
    project: projectRoot ? basename(projectRoot) : undefined,
    cwd: input.currentDirectory,
    worktree: "unknown",
    lastTargetId: input.lastTargetId,
  });
}

function receiptStateFromFlight(
  flight: ScoutFlightRecord | undefined,
): ScoutAskReceipt["state"] {
  if (!flight) {
    return "failed";
  }
  if (flight.state === "completed") {
    return "completed";
  }
  if (flight.state === "failed" || flight.state === "cancelled") {
    return "failed";
  }
  return "queued";
}

function compactAskIds(ids: ScoutAskReceipt["ids"]): ScoutAskReceipt["ids"] {
  return Object.fromEntries(
    Object.entries(ids).filter(([, value]) => value !== undefined && value !== ""),
  ) as ScoutAskReceipt["ids"];
}

type ScoutAskDeliveryResult = {
  usedBroker: boolean;
  flight?: ScoutFlightRecord;
  conversationId?: string;
  messageId?: string;
  bindingRef?: string;
  sessionAlias?: string;
  executionResolution?: ScoutAskReceipt["executionResolution"];
  workItem?: ScoutAskResult["workItem"];
  targetDiagnostic?: ScoutAskResult["targetDiagnostic"];
};

type ScoutAskResolvedTarget = {
  target: ScoutRouteTarget;
  display: string;
};

function nextCallForAskFailure(input: {
  target: ScoutAskResolvedTarget;
  result: ScoutAskDeliveryResult;
  currentDirectory: string;
}): ScoutAskNextCall | undefined {
  if (!input.result.usedBroker) {
    return undefined;
  }

  if (input.result.targetDiagnostic?.state === "ambiguous") {
    if (input.target.target.kind === "project_path") {
      return {
        tool: "agents_search",
        arguments: {
          query: input.target.display,
          currentDirectory: input.currentDirectory,
        },
        reason: "Choose one concrete project agent, then retry the ask.",
      };
    }
    const candidates = input.result.targetDiagnostic.candidates
      .map((candidate) => candidate.label || candidate.agentId)
      .filter(Boolean);
    return {
      tool: "agents_resolve",
      arguments: {
        label: input.target.display,
        currentDirectory: input.currentDirectory,
      },
      reason: input.result.targetDiagnostic.detail
        ?? (candidates.length > 0
          ? `${input.target.display} matches multiple agents: ${candidates.join(", ")}. Retry with one fully qualified handle.`
          : "Choose one concrete target, then retry the ask."),
    };
  }

  if (!input.result.flight) {
    return {
      tool: "agents_search",
      arguments: {
        query: input.target.display,
        currentDirectory: input.currentDirectory,
      },
      reason: "Find a routable target, then retry the ask.",
    };
  }

  return undefined;
}

function buildScoutAskReceipt(input: {
  target: ScoutAskResolvedTarget;
  result: ScoutAskDeliveryResult;
  currentDirectory: string;
}): ScoutAskReceipt {
  if (!input.result.usedBroker) {
    return {
      ok: false,
      state: "failed",
      ids: {},
      error: {
        code: "broker_unreachable",
        message: "broker is not reachable",
      },
    };
  }

  const state = input.result.targetDiagnostic?.state === "ambiguous"
    ? "ambiguous"
    : receiptStateFromFlight(input.result.flight);
  const ok = state === "queued" || state === "completed";
  const next = ok
    ? undefined
    : nextCallForAskFailure({
        target: input.target,
        result: input.result,
        currentDirectory: input.currentDirectory,
      });

  return {
    ok,
    state,
    ids: compactAskIds({
      targetAgentId: input.result.flight?.targetAgentId,
      invocationId: input.result.flight?.invocationId,
      flightId: input.result.flight?.id,
      conversationId: input.result.conversationId,
      messageId: input.result.messageId,
      workId: input.result.workItem?.id,
      bindingRef: input.result.bindingRef,
      sessionAlias: input.result.sessionAlias,
    }),
    ...(input.result.executionResolution
      ? { executionResolution: input.result.executionResolution }
      : {}),
    ...(next ? { next } : {}),
  };
}

function executionSessionForAsk(
  session: ScoutAskCommand["session"],
): "new" | "existing" | "any" | undefined {
  if (session === "new") {
    return "new";
  }
  return undefined;
}

function renderedAskTarget(target: ScoutRouteTarget): string {
  switch (target.kind) {
    case "agent_id":
      return target.agentId;
    case "agent_label":
      return target.label;
    case "existing_handle":
      return target.value ?? `@${target.handle.replace(/^@+/, "")}`;
    case "runtime_profile":
      return target.value ?? `profile:${target.profile}`;
    case "route_alias":
      return target.value ?? `alias:${target.alias}`;
    case "target_handle":
      return target.value ?? `target:${target.handle}`;
    case "session_id":
      return target.value ?? `session:${target.sessionId}`;
    case "binding_ref":
      return `ref:${target.ref}`;
    case "project_path":
      return target.projectPath;
    case "channel":
      return `channel:${target.channel}`;
    case "broadcast":
      return "broadcast";
  }
}

function askTargetFor(to: string): ScoutRouteTarget | null {
  const parsed = parseScoutComposerRouteTarget(to);
  if (!parsed) {
    return { kind: "agent_label", label: to };
  }
  if (parsed.kind === "agent_id") {
    return { kind: "agent_id", agentId: parsed.agentId };
  }
  if (parsed.kind === "binding_ref") {
    return { kind: "binding_ref", ref: parsed.ref };
  }
  if (parsed.kind === "target_handle") {
    return { kind: "target_handle", handle: parsed.handle, ...(parsed.value ? { value: parsed.value } : {}) };
  }
  if (parsed.kind === "session_id") {
    return {
      kind: "session_id",
      sessionId: parsed.sessionId,
      ...(parsed.harness ? { harness: parsed.harness } : {}),
      ...(parsed.value ? { value: parsed.value } : {}),
    };
  }
  if (parsed.kind === "agent_label") {
    return { kind: "agent_label", label: parsed.label };
  }
  if (parsed.kind === "route_alias") {
    return { kind: "route_alias", alias: parsed.alias, ...(parsed.scope ? { scope: parsed.scope } : {}), ...(parsed.value ? { value: parsed.value } : {}) };
  }
  return null;
}

function resolveAskProjectPath(
  projectPath: string | undefined,
  currentDirectory: string,
): string | undefined {
  const trimmed = projectPath?.trim();
  return trimmed ? resolve(currentDirectory, trimmed) : undefined;
}

function shouldInferCurrentProjectAskTarget(
  command: ScoutAskCommand,
): boolean {
  return Boolean(command.harness || command.model || command.reasoningEffort || command.workspace || command.session);
}

function isProjectRouteTarget(to: string): boolean {
  const parsed = parseScoutComposerRouteTarget(to);
  return parsed?.kind === "project_path";
}

export function buildScoutAskRoute(input: {
  to: string;
  projectPath?: string;
  runtimeProfile?: string;
  existingHandle?: string;
  currentDirectory: string;
  reasoningEffort?: string;
  aliasScope?: import("@openscout/protocol").RouteAliasScope;
}): ScoutRouteTarget | null {
  if (input.runtimeProfile) {
    const target = {
      kind: "runtime_profile" as const,
      profile: input.runtimeProfile,
      projectPath: resolve(input.currentDirectory, input.projectPath?.trim() || "."),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    };
    return target;
  }
  if (input.existingHandle) {
    const handle = input.existingHandle.replace(/^@+/, "");
    const target = {
      kind: "existing_handle" as const,
      handle,
      value: `@${handle}`,
    };
    return target;
  }
  if (input.projectPath) {
    const target = {
      kind: "project_path" as const,
      projectPath: input.projectPath,
    };
    return target;
  }
  if (!input.to) {
    return null;
  }
  const parsedTarget = askTargetFor(input.to);
  const target = parsedTarget?.kind === "route_alias" && input.aliasScope
    ? { ...parsedTarget, scope: input.aliasScope }
    : parsedTarget;
  return target;
}

export const scoutAskHandler: ScoutAskHandler = async (command) => {
  const currentDirectory = command.currentDirectory ?? process.cwd();
  const commandProjectPath = resolveAskProjectPath(
    command.projectPath,
    currentDirectory,
  );
  const requestedTo = command.to?.trim() || "";
  const requestedRuntimeProfile = command.runtimeProfile?.trim() || "";
  const requestedExistingHandle = command.existingHandle?.trim() || "";
  const inferredProjectPath =
    !requestedTo
    && !requestedRuntimeProfile
    && !requestedExistingHandle
    && !commandProjectPath
    && shouldInferCurrentProjectAskTarget(command)
      ? currentDirectory
      : undefined;
  const targetProjectPath = commandProjectPath ?? inferredProjectPath;
  const projectAgent =
    targetProjectPath
    && !requestedTo
    && (inferredProjectPath || command.session === "new")
      ? { persistence: "one_time" as const }
      : requestedRuntimeProfile
      ? { persistence: "one_time" as const }
      : undefined;
  const explicitTargetCount = [
    requestedTo || requestedExistingHandle,
    commandProjectPath || requestedRuntimeProfile,
  ].filter(Boolean).length;
  if (explicitTargetCount > 1) {
    return {
      ok: false,
      state: "failed",
      ids: {},
      error: {
        code: "invalid_request",
        message: "provide one existing target, or a project/runtime launch target",
      },
    };
  }
  if (requestedTo && isProjectRouteTarget(requestedTo)) {
    return {
      ok: false,
      state: "failed",
      ids: {},
      error: {
        code: "invalid_request",
        message: "project targets must use projectPath",
      },
    };
  }
  const target = buildScoutAskRoute({
    to: requestedTo,
    projectPath: targetProjectPath,
    runtimeProfile: requestedRuntimeProfile,
    existingHandle: requestedExistingHandle,
    currentDirectory,
    reasoningEffort: command.reasoningEffort,
    aliasScope: command.aliasScope,
  });
  if (!target) {
    return {
      ok: false,
      state: "failed",
      ids: {},
      next: {
        tool: "agents_search",
        arguments: { currentDirectory },
        reason: "Pick a target, then retry the ask.",
      },
    };
  }
  const resolvedTarget = {
    target,
    display: renderedAskTarget(target),
  };

  const senderContext = command.senderContext
    ?? await buildScoutAskSenderContext({
      senderId: command.senderId,
      currentDirectory,
    });
  const result = await deliverScoutAsk({
    senderId: command.senderId,
    target: resolvedTarget.target,
    targetLabel: resolvedTarget.display,
    body: command.body,
    workItem: command.workItem,
    labels: command.labels,
    replyToSessionId: command.replyToSessionId,
    replyMode: command.replyMode,
    channel: command.channel,
    shouldSpeak: command.shouldSpeak,
    executionHarness: command.harness,
    executionModel: command.model,
    executionReasoningEffort: command.reasoningEffort,
    executionPlacement: command.placement,
    executionSource: command.executionSource,
    executionSession: executionSessionForAsk(command.session),
    workspace: command.workspace,
    senderContext,
    projectAgent,
    currentDirectory,
    source: command.source ?? "scout-ask",
  });

  return buildScoutAskReceipt({
    target: resolvedTarget,
    result,
    currentDirectory,
  });
};
