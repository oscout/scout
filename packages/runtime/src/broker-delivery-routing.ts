import {
  parseAgentIdentity,
  type AgentDefinition,
  type AgentHarness,
  type InvocationRequest,
  type ScoutDeliveryReceipt,
  type ScoutDeliveryRemediationAction,
  type ScoutDeliverRequest,
  type ScoutDeliverRouteKind,
  type ScoutDispatchRecord,
  type RouteAliasResolutionProof,
  type ScoutCallerContext,
  type ScoutRouteTarget,
} from "@openscout/protocol";

import { SUPPORTED_SCOUT_HARNESSES } from "./local-agents.js";
import { executionForBrokerRuntimeProfile } from "./broker-runtime-profiles.js";
import {
  resolveBrokerRouteTarget,
  type BrokerLabelResolution,
  type BrokerRouteTargetInput,
  type RuntimeSnapshot,
} from "./scout-dispatcher.js";
import {
  BrokerRouteAliasError,
  type BrokerRouteAliasService,
  type RouteAliasDispatchResolution,
} from "./broker-route-alias-service.js";

export type InvocationResolution =
  | { kind: "resolved"; agent: AgentDefinition; aliasResolution?: RouteAliasResolutionProof }
  | (Extract<BrokerLabelResolution, { kind: "resolved_session" }> & { aliasResolution?: RouteAliasResolutionProof })
  | Exclude<BrokerLabelResolution, { kind: "resolved" | "resolved_session" }>;

export type ExactSessionWakeInput = {
  nativeSessionId: string;
  harness?: AgentHarness;
  projectPath?: string;
  requesterId?: string;
};

export type ExactSessionWakeResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      detail: string;
      remediation?: string;
    };

export type BrokerDeliveryRouterOptions = {
  runtimeSnapshot: () => RuntimeSnapshot;
  nodeId: string;
  isInactiveLocalAgent: (agent: AgentDefinition | undefined) => boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  routeAliasService?: BrokerRouteAliasService;
  resolveRemoteRouteAlias?: (
    target: Extract<ScoutRouteTarget, { kind: "route_alias" }>,
    caller: ScoutCallerContext,
  ) => Promise<RouteAliasDispatchResolution | null>;
  /**
   * When an exact session target is unknown in the live registry, attempt to
   * locate/resume it (harness store → cardless flat-dispatch endpoint) and
   * re-resolve. Must never invent a different agent/card target.
   */
  wakeExactHarnessSession?: (input: ExactSessionWakeInput) => Promise<ExactSessionWakeResult>;
};

export function callerContextForDelivery(
  payload: ScoutDeliverRequest,
  defaults: { operatorActorId: string; nodeId: string },
): { requesterId: string; requesterNodeId: string } {
  return {
    requesterId: payload.caller?.actorId?.trim() || payload.requesterId?.trim() || defaults.operatorActorId,
    requesterNodeId: payload.caller?.nodeId?.trim() || payload.requesterNodeId?.trim() || defaults.nodeId,
  };
}

export function agentLabelForRouteParams(payload: Pick<ScoutDeliverRequest, "target" | "targetLabel">): string | undefined {
  if (payload.target?.kind === "agent_label") {
    return payload.target.label;
  }
  if (!payload.target && payload.targetLabel?.trim()) {
    return payload.targetLabel;
  }
  return undefined;
}

export function supportedRouteHarness(value: string | undefined): AgentHarness | undefined {
  const normalized = value?.trim() as AgentHarness | undefined;
  if (normalized && SUPPORTED_SCOUT_HARNESSES.includes(normalized)) {
    return normalized;
  }
  return undefined;
}

export function supportedRouteModel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function executionWithRouteParams(payload: ScoutDeliverRequest): InvocationRequest["execution"] | undefined {
  if (payload.target?.kind === "runtime_profile") {
    const profileExecution = executionForBrokerRuntimeProfile({
      profileId: payload.target.profile,
      reasoningEffort: payload.target.reasoningEffort,
    });
    if (!profileExecution) {
      return payload.execution;
    }
    if (
      payload.execution?.harness
      && profileExecution.harness
      && payload.execution.harness !== profileExecution.harness
    ) {
      throw new Error(
        `runtime_conflict: runtime profile "${payload.target.profile}" requires harness "${profileExecution.harness}"; `
          + `explicit harness "${payload.execution.harness}" conflicts`,
      );
    }
    return {
      ...profileExecution,
      ...(payload.execution ?? {}),
      harness: profileExecution.harness,
      session: "new",
    };
  }
  const label = agentLabelForRouteParams(payload);
  const identity = label
    ? parseAgentIdentity(label.startsWith("@") ? label : `@${label}`)
    : null;
  const targetHarness = payload.target?.kind === "session_id"
    ? payload.target.harness
    : undefined;
  const harness = payload.execution?.harness
    ? undefined
    : targetHarness ?? supportedRouteHarness(identity?.harness);
  const model = payload.execution?.model ? undefined : supportedRouteModel(identity?.model);
  if (!harness && !model) {
    return payload.execution;
  }

  return {
    ...(payload.execution ?? {}),
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
  };
}

export function projectPathRouteTarget(input: BrokerRouteTargetInput): string | undefined {
  if (input.target?.kind === "project_path" || input.target?.kind === "runtime_profile") {
    return input.target.projectPath.trim() || undefined;
  }
  return undefined;
}

/** Exact harness session route — never demotes to project/card workers. */
export function exactSessionRouteTarget(input: BrokerRouteTargetInput): {
  nativeSessionId: string;
  harness?: AgentHarness;
  label: string;
} | null {
  if (input.target?.kind === "session_id") {
    const nativeSessionId = input.target.sessionId.trim();
    if (!nativeSessionId) return null;
    const harness = input.target.harness ?? input.execution?.harness;
    return {
      nativeSessionId,
      ...(harness ? { harness } : {}),
      label: harness ? `session:${harness}:${nativeSessionId}` : `session:${nativeSessionId}`,
    };
  }
  const bare = input.targetSessionId?.trim();
  if (bare) {
    const harness = input.execution?.harness;
    return {
      nativeSessionId: bare,
      ...(harness ? { harness } : {}),
      label: harness ? `session:${harness}:${bare}` : `session:${bare}`,
    };
  }
  return null;
}

export function shouldMaterializeProjectAgent(input: {
  projectPath?: string;
  resolved: InvocationResolution;
  projectAgent?: unknown;
  execution?: InvocationRequest["execution"];
}): boolean {
  void input;
  // Project paths are route selectors. Delivery must not synthesize agent
  // cards when a path is unknown or ambiguous; callers can target a session id
  // for exact continuation or use explicit session/card APIs when they want a
  // new named identity.
  return false;
}

export function remediationForDispatch(
  dispatch: ScoutDispatchRecord,
): ScoutDeliveryRemediationAction {
  if (dispatch.kind === "ambiguous") {
    return {
      kind: "choose_target",
      detail: dispatch.detail,
      targetLabel: dispatch.askedLabel,
      dispatchId: dispatch.id,
    };
  }
  if (dispatch.kind === "unavailable") {
    return {
      kind: dispatch.target?.reason === "manual_wake_required"
        ? "wake_target"
        : dispatch.target?.reason === "session_reference_not_attachable"
        ? "session_reference_not_attachable"
        : dispatch.target?.reason === "superseded_registration" || dispatch.target?.reason === "stale_registration"
        ? "use_current_registration"
        : "retry_later",
      detail: dispatch.target?.detail ?? dispatch.detail,
      targetAgentId: dispatch.target?.agentId,
      targetLabel: dispatch.askedLabel,
      dispatchId: dispatch.id,
    };
  }
  return {
    kind: dispatch.kind === "unknown" ? "register_target" : "choose_target",
    detail: dispatch.detail,
    targetLabel: dispatch.askedLabel,
    dispatchId: dispatch.id,
  };
}

export function buildDeliveryReceipt(input: {
  requestId: string;
  routeKind: ScoutDeliverRouteKind;
  requesterId: string;
  requesterNodeId: string;
  targetAgentId?: string;
  targetSessionId?: string;
  targetLabel: string;
  sessionAlias?: string;
  bindingRef?: string;
  conversationId: string;
  messageId: string;
  flightId?: string;
  executionResolution?: ScoutDeliveryReceipt["executionResolution"];
  aliasResolution?: RouteAliasResolutionProof;
}): ScoutDeliveryReceipt {
  return {
    requestId: input.requestId,
    routeKind: input.routeKind,
    requesterId: input.requesterId,
    requesterNodeId: input.requesterNodeId,
    targetAgentId: input.targetAgentId,
    targetSessionId: input.targetSessionId,
    targetLabel: input.targetLabel,
    ...(input.sessionAlias ? { sessionAlias: input.sessionAlias } : {}),
    ...(input.bindingRef ? { bindingRef: input.bindingRef } : {}),
    conversationId: input.conversationId,
    messageId: input.messageId,
    ...(input.flightId ? { flightId: input.flightId } : {}),
    ...(input.executionResolution ? { executionResolution: input.executionResolution } : {}),
    ...(input.aliasResolution ? { aliasResolution: input.aliasResolution } : {}),
    acceptedAt: Date.now(),
  };
}

export function normalizeScoutLabels(labels: string[] | undefined): string[] {
  if (!labels) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export class BrokerDeliveryRouter {
  constructor(private readonly options: BrokerDeliveryRouterOptions) {}

  resolveTarget(input: BrokerRouteTargetInput): InvocationResolution {
    return resolveBrokerRouteTarget(this.options.runtimeSnapshot(), input, {
      preferLocalNodeId: this.options.nodeId,
      helpers: { isStale: this.options.isInactiveLocalAgent },
    });
  }

  async resolveWithImplicitProjectAgent(
    input: BrokerRouteTargetInput & {
      execution?: InvocationRequest["execution"];
      projectAgent?: unknown;
    },
    resolveOptions: {
      requesterId?: string;
      currentDirectory?: string;
      reason: string;
    },
  ): Promise<InvocationResolution> {
    const caller = {
      actorId: resolveOptions.requesterId,
      nodeId: this.options.nodeId,
      currentDirectory: resolveOptions.currentDirectory,
    };
    const target = input.target;
    if (target?.kind === "route_alias") {
      try {
        const remoteAlias = await this.options.resolveRemoteRouteAlias?.(target, caller);
        if (remoteAlias) {
          return { ...remoteAlias.resolution, aliasResolution: remoteAlias.proof };
        }
        const alias = this.options.routeAliasService?.resolveForDispatch(target, caller);
        return alias ? { ...alias.resolution, aliasResolution: alias.proof } : { kind: "unknown", label: `alias:${target.alias}` };
      } catch (error) {
        return {
          kind: "unknown",
          label: `alias:${target.alias}`,
          detail: `alias:${target.alias} lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          ...(error instanceof BrokerRouteAliasError ? { diagnosticCode: error.code } : {}),
        };
      }
    }
    if (target?.kind === "target_handle" && this.options.routeAliasService) {
      try {
        const alias = this.options.routeAliasService.resolveBareForDispatch(target.handle, caller);
        if (alias) return { ...alias.resolution, aliasResolution: alias.proof };
      } catch (error) {
        return {
          kind: "unknown",
          label: target.value ?? `target:${target.handle}`,
          detail: `${target.value ?? `target:${target.handle}`} alias lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          ...(error instanceof BrokerRouteAliasError ? { diagnosticCode: error.code } : {}),
        };
      }
    }
    const native = this.resolveTarget(input);

    // Exact session targets never fall through to project/label/capability
    // routing. If unknown, try harness-store wake then re-resolve only that id.
    const exactSession = exactSessionRouteTarget(input);
    if (exactSession && native.kind === "unknown") {
      if (!this.options.wakeExactHarnessSession) {
        return {
          kind: "unknown",
          label: exactSession.label,
          detail: native.detail
            ?? `session ${exactSession.nativeSessionId} is not currently routable (no live endpoint and no wake path)`,
        };
      }
      const wake = await this.options.wakeExactHarnessSession({
        nativeSessionId: exactSession.nativeSessionId,
        harness: exactSession.harness,
        projectPath: resolveOptions.currentDirectory,
        requesterId: resolveOptions.requesterId,
      });
      if (!wake.ok) {
        return {
          kind: "unknown",
          label: exactSession.label,
          detail: wake.detail || wake.reason,
        };
      }
      const afterWake = this.resolveTarget(input);
      if (afterWake.kind === "resolved" || afterWake.kind === "resolved_session") {
        this.options.log?.(
          `[openscout-runtime] woke exact harness session ${exactSession.label}`,
        );
        return afterWake;
      }
      return {
        kind: "unknown",
        label: exactSession.label,
        detail: afterWake.kind === "unknown"
          ? (afterWake.detail ?? `session ${exactSession.nativeSessionId} still not routable after wake`)
          : `session ${exactSession.nativeSessionId} wake did not produce a session resolution`,
      };
    }

    if (native.kind !== "unknown" || !this.options.routeAliasService) return native;
    const label = target?.kind === "agent_label"
      ? target.label
      : !target
      ? input.targetLabel?.trim()
      : undefined;
    if (!label) return native;
    try {
      const alias = this.options.routeAliasService.resolveBareForDispatch(label, caller);
      return alias ? { ...alias.resolution, aliasResolution: alias.proof } : native;
    } catch (error) {
      return {
        kind: "unknown",
        label,
        detail: `${native.detail ?? `no agent matches ${label}`}; route alias ${label} lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        ...(error instanceof BrokerRouteAliasError ? { diagnosticCode: error.code } : {}),
      };
    }
  }

  resolveInvocationTarget(
    payload: InvocationRequest & BrokerRouteTargetInput,
  ): Promise<InvocationResolution> {
    const contextDirectory = typeof payload.context?.currentDirectory === "string"
      ? payload.context.currentDirectory.trim() || undefined
      : undefined;
    return this.resolveWithImplicitProjectAgent({
      target: payload.target,
      targetAgentId: payload.targetAgentId,
      targetSessionId: payload.targetSessionId,
      targetLabel: payload.targetLabel,
      routePolicy: payload.routePolicy,
      execution: payload.execution,
      projectAgent: undefined,
    }, {
      requesterId: payload.requesterId,
      currentDirectory: contextDirectory ?? projectPathRouteTarget(payload),
      reason: "implicit project invocation card",
    });
  }
}
