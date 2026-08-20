import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  AgentHarness,
  InvocationRequest,
} from "@openscout/protocol";

import { isA2AHttpEndpoint } from "./a2a-http-endpoint.js";
import {
  compareLocalEndpointPreference,
  endpointMatchesTargetSession,
} from "./broker-endpoint-selection.js";
import {
  invocationTargetSessionId,
  staleLocalEndpointReason,
} from "./broker-local-invocation-helpers.js";
import {
  isBrokerRunnableLocalAgentTransport,
  isDirectLocalAgentTransport,
} from "./local-agent-transports.js";
import {
  clearEndpointFailureMetadata,
  type LocalAgentBinding,
} from "./local-agents.js";

type LocalEndpointRuntime = {
  endpointsForAgent(
    agentId: string,
    options?: {
      includeOffline?: boolean;
      nodeId?: string;
      harness?: AgentEndpoint["harness"];
    },
  ): AgentEndpoint[];
};

export type BrokerLocalEndpointResolverOptions = {
  nodeId: string;
  runtime: LocalEndpointRuntime;
  isLocalAgentEndpointAlive: (endpoint: AgentEndpoint) => boolean;
  isLocalAgentEndpointAliveAsync?: (endpoint: AgentEndpoint) => Promise<boolean>;
  ensureLocalSessionEndpointOnline: (endpoint: AgentEndpoint) => Promise<{
    externalSessionId?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  ensureLocalAgentBindingOnline: (
    agentId: string,
    nodeId: string,
    options: {
      includeDiscovered?: boolean;
      harness?: AgentHarness;
    },
  ) => Promise<LocalAgentBinding | null>;
  /**
   * Spawn a one-invocation session attached to a durable agent without
   * changing that agent's configured endpoint or runtime metadata.
   */
  createIsolatedAgentEndpoint?: (invocation: InvocationRequest) => Promise<AgentEndpoint | null>;
  upsertActor: (actor: ActorIdentity) => Promise<void>;
  upsertAgent: (agent: AgentDefinition) => Promise<void>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  now?: () => number;
};

export type LocalSessionPreparationResult = {
  externalSessionId?: string | null;
  metadata?: Record<string, unknown>;
};

function metadataSessionId(
  metadata: AgentEndpoint["metadata"] | undefined,
  key: "externalSessionId" | "threadId" | "nativeSessionId",
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The harness-owned conversation id, distinct from Scout routing identity. */
export function localEndpointProviderSessionId(endpoint: AgentEndpoint): string | null {
  return metadataSessionId(endpoint.metadata, "externalSessionId")
    ?? metadataSessionId(endpoint.metadata, "threadId")
    ?? metadataSessionId(endpoint.metadata, "nativeSessionId");
}

/** Prefer provider identity in traces, while retaining legacy endpoint fallbacks. */
export function localEndpointTraceSessionId(endpoint: AgentEndpoint): string | null {
  return localEndpointProviderSessionId(endpoint)
    ?? endpoint.sessionId?.trim()
    ?? null;
}

/**
 * Attach provider-owned identity without changing endpoint.sessionId, which is
 * the stable Scout routing identity for cardless and isolated sessions.
 */
export function promoteLocalEndpointProviderSession(
  endpoint: AgentEndpoint,
  result: LocalSessionPreparationResult,
): AgentEndpoint {
  const resultMetadata = result.metadata ?? {};
  const metadataProviderSessionId = metadataSessionId(resultMetadata, "externalSessionId")
    || metadataSessionId(resultMetadata, "threadId")
    || metadataSessionId(resultMetadata, "nativeSessionId")
    || null;
  // Pi's direct result id is the Scout adapter/runtime key, not Pi's native
  // session identity. Only provider metadata may promote a Pi endpoint.
  const reportedSessionId = endpoint.transport === "pi_rpc"
    ? metadataProviderSessionId
    : result.externalSessionId?.trim() || metadataProviderSessionId;
  return {
    ...endpoint,
    metadata: {
      ...(endpoint.metadata ?? {}),
      ...resultMetadata,
      ...(reportedSessionId ? {
        externalSessionId: reportedSessionId,
        pendingExternalSession: false,
        ...(endpoint.transport === "codex_app_server" ? { threadId: reportedSessionId } : {}),
      } : {}),
    },
  };
}

export class BrokerLocalEndpointResolver {
  constructor(private readonly options: BrokerLocalEndpointResolverOptions) {}

  activeLocalEndpointForAgent(
    agentId: string,
    harness?: AgentEndpoint["harness"],
    targetSessionId?: string,
    options: { includeWakeable?: boolean } = {},
  ): AgentEndpoint | undefined {
    const candidates = this.options.runtime.endpointsForAgent(agentId, {
      nodeId: this.options.nodeId,
      harness,
    }).filter((endpoint) => {
      if (endpoint.metadata?.staleLocalRegistration === true) {
        return false;
      }
      return targetSessionId ? endpointMatchesTargetSession(endpoint, targetSessionId) : true;
    });
    const orderedCandidates = targetSessionId
      ? candidates
      : [...candidates].sort(compareLocalEndpointPreference);
    return orderedCandidates.find((endpoint) => (
      isA2AHttpEndpoint(endpoint)
        ? true
        : endpoint.transport === "pairing_bridge"
        ? endpoint.state !== "offline"
        : (options.includeWakeable && isWakeableSessionBackedEndpoint(endpoint))
          || this.options.isLocalAgentEndpointAlive(endpoint)
    ));
  }

  async resolveLocalEndpointForInvocation(invocation: InvocationRequest): Promise<AgentEndpoint | undefined> {
    const requestedHarness = invocation.execution?.harness;
    const targetSessionId = invocationTargetSessionId(invocation);
    const sessionPreference = invocation.execution?.session ?? "new";
    const shouldUseExistingSession = Boolean(targetSessionId);
    const hasExplicitRuntime = invocationHasExplicitRuntime(invocation);
    const existing = await this.activeLocalEndpointForInvocation(
      invocation.targetAgentId,
      requestedHarness,
      targetSessionId,
      { includeWakeable: invocation.ensureAwake },
    );
    if (
      hasExplicitRuntime
      && !shouldUseExistingSession
      && sessionPreference !== "existing"
      && invocation.ensureAwake
      && this.options.createIsolatedAgentEndpoint
    ) {
      const isolatedEndpoint = await this.options.createIsolatedAgentEndpoint(invocation);
      if (isolatedEndpoint) {
        await this.options.persistEndpoint(isolatedEndpoint);
        return isolatedEndpoint;
      }
    }
    if (
      existing
      && (
        shouldUseExistingSession
        || existing.transport === "pairing_bridge"
        || isA2AHttpEndpoint(existing)
        || isBrokerRunnableLocalAgentTransport(existing.transport)
      )
    ) {
      assertEndpointPlacementMatches(existing, invocation);
      if (hasExplicitRuntime) {
        assertEndpointObservedRuntimeMatches(existing, invocation, this.now());
      }
      return existing;
    }

    if (!shouldUseExistingSession && sessionPreference === "existing") {
      return undefined;
    }

    const staleEndpoints = shouldUseExistingSession
      ? this.options.runtime.endpointsForAgent(invocation.targetAgentId, {
          nodeId: this.options.nodeId,
          harness: requestedHarness,
        }).filter((endpoint) =>
          endpoint.id !== existing?.id
          && endpointMatchesTargetSession(endpoint, targetSessionId!)
        )
      : [];
    const staleLocalReason = staleEndpoints
      .map((endpoint) => staleLocalEndpointReason(endpoint))
      .find((reason): reason is string => Boolean(reason));
    if (staleLocalReason) {
      throw new Error(staleLocalReason);
    }

    if (invocation.ensureAwake && shouldUseExistingSession) {
      for (const endpoint of staleEndpoints) {
        assertEndpointPlacementMatches(endpoint, invocation);
        try {
          const revived = await this.reviveExactSessionEndpoint(endpoint);
          if (revived) return revived;
        } catch (error) {
          await this.options.persistEndpoint({
            ...endpoint,
            state: "offline",
            metadata: {
              ...(endpoint.metadata ?? {}),
              lastError: error instanceof Error ? error.message : String(error),
              lastFailedAt: this.now(),
            },
          });
        }
      }
    }

    for (const endpoint of staleEndpoints) {
      await this.options.persistEndpoint({
        ...endpoint,
        state: "offline",
        metadata: {
          ...(endpoint.metadata ?? {}),
          lastError: endpoint.transport === "tmux"
            ? `tmux session missing: ${endpoint.sessionId ?? endpoint.id}`
            : `${endpoint.transport} session unavailable: ${endpoint.sessionId ?? endpoint.id}`,
          lastFailedAt: this.now(),
        },
      });
    }

    if (targetSessionId && invocation.ensureAwake) {
      throw new Error(`session ${targetSessionId} is not currently reachable`);
    }

    if (!invocation.ensureAwake) {
      return undefined;
    }

    if (targetSessionId) {
      return undefined;
    }

    const binding = await this.options.ensureLocalAgentBindingOnline(invocation.targetAgentId, this.options.nodeId, {
      includeDiscovered: true,
      harness: requestedHarness,
    });
    if (!binding) {
      return undefined;
    }

    if (binding.actor.id !== binding.agent.id) {
      await this.options.upsertActor(binding.actor);
    }
    await this.options.upsertAgent(binding.agent);
    await this.options.persistEndpoint(binding.endpoint);
    return binding.endpoint;
  }

  async prepareLocalEndpointForInvocation(endpoint: AgentEndpoint): Promise<AgentEndpoint> {
    if (
      endpoint.metadata?.sessionBacked !== true
      || (
        endpoint.transport !== "codex_app_server"
        && endpoint.transport !== "claude_stream_json"
        && endpoint.transport !== "pi_rpc"
      )
      || (
        endpoint.metadata?.pendingExternalSession !== true
        && localEndpointProviderSessionId(endpoint)
      )
    ) {
      return endpoint;
    }

    const sessionResult = await this.options.ensureLocalSessionEndpointOnline(endpoint);
    const preparedEndpoint = promoteLocalEndpointProviderSession(endpoint, sessionResult);
    // Persist immediately after the provider responds. The following turn may
    // remain active for minutes, but observe/trace consumers can resolve the
    // concrete harness session as soon as the running flight is acknowledged.
    await this.options.persistEndpoint(preparedEndpoint);
    return preparedEndpoint;
  }

  private async reviveExactSessionEndpoint(endpoint: AgentEndpoint): Promise<AgentEndpoint | null> {
    if (!isDirectLocalAgentTransport(endpoint.transport)) {
      return null;
    }

    const sessionResult = await this.options.ensureLocalSessionEndpointOnline(endpoint);
    const preparedEndpoint = promoteLocalEndpointProviderSession({
      ...endpoint,
      metadata: clearEndpointFailureMetadata(endpoint.metadata),
    }, sessionResult);
    const revivedEndpoint: AgentEndpoint = {
      ...preparedEndpoint,
      state: "idle",
      metadata: {
        ...(preparedEndpoint.metadata ?? {}),
        lastResumedAt: this.now(),
      },
    };
    await this.options.persistEndpoint(revivedEndpoint);
    return revivedEndpoint;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async activeLocalEndpointForInvocation(
    agentId: string,
    harness?: AgentEndpoint["harness"],
    targetSessionId?: string,
    options: { includeWakeable?: boolean } = {},
  ): Promise<AgentEndpoint | undefined> {
    const candidates = this.options.runtime.endpointsForAgent(agentId, {
      nodeId: this.options.nodeId,
      harness,
    }).filter((endpoint) => {
      if (endpoint.metadata?.staleLocalRegistration === true) {
        return false;
      }
      return targetSessionId ? endpointMatchesTargetSession(endpoint, targetSessionId) : true;
    });
    const orderedCandidates = targetSessionId
      ? candidates
      : [...candidates].sort(compareLocalEndpointPreference);

    for (const endpoint of orderedCandidates) {
      if (this.endpointIsLocallyUsableFromSnapshot(endpoint, options)) {
        return endpoint;
      }
      const alive = this.options.isLocalAgentEndpointAliveAsync
        ? await this.options.isLocalAgentEndpointAliveAsync(endpoint)
        : this.options.isLocalAgentEndpointAlive(endpoint);
      if (alive) {
        return endpoint;
      }
    }
    return undefined;
  }

  private endpointIsLocallyUsableFromSnapshot(
    endpoint: AgentEndpoint,
    options: { includeWakeable?: boolean } = {},
  ): boolean {
    if (isA2AHttpEndpoint(endpoint)) {
      return true;
    }
    if (endpoint.transport === "pairing_bridge") {
      return endpoint.state !== "offline";
    }
    if (options.includeWakeable && isWakeableSessionBackedEndpoint(endpoint)) {
      return true;
    }
    return this.options.isLocalAgentEndpointAlive(endpoint);
  }
}

function invocationHasExplicitRuntime(invocation: InvocationRequest): boolean {
  return Boolean(
    invocation.execution?.harness?.trim()
    || invocation.execution?.model?.trim()
    || invocation.execution?.reasoningEffort?.trim()
    || invocation.execution?.placement,
  );
}

function endpointPlacement(endpoint: AgentEndpoint): "background" | "foreground" {
  if (endpoint.metadata?.placement === "foreground") return "foreground";
  if (endpoint.metadata?.placement === "background") return "background";
  return endpoint.transport === "codex_app_server" ? "foreground" : "background";
}

function assertEndpointPlacementMatches(endpoint: AgentEndpoint, invocation: InvocationRequest): void {
  const requested = invocation.execution?.placement;
  if (!requested) return;
  const actual = endpointPlacement(endpoint);
  if (requested !== actual) {
    throw new Error(
      `session_placement_conflict: session ${endpoint.sessionId ?? endpoint.id} is ${actual}; `
      + `request ${requested} with a new session instead`,
    );
  }
}

type ObservedRuntime = {
  harness?: string;
  model?: string;
  reasoningEffort?: string;
};

export function observedRuntimeForEndpoint(endpoint: AgentEndpoint): ObservedRuntime {
  const metadata = endpoint.metadata ?? {};
  const nested = metadata.observedRuntime;
  const observed = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
  const stringValue = (value: unknown): string | undefined => (
    typeof value === "string" && value.trim() ? value.trim() : undefined
  );
  return {
    harness: stringValue(observed.harness) ?? stringValue(metadata.observedHarness),
    model: stringValue(observed.model) ?? stringValue(metadata.observedModel),
    reasoningEffort: stringValue(observed.reasoningEffort)
      ?? stringValue(metadata.observedReasoningEffort),
  };
}

function assertEndpointObservedRuntimeMatches(
  endpoint: AgentEndpoint,
  invocation: InvocationRequest,
  now: number,
): void {
  const observed = observedRuntimeForEndpoint(endpoint);
  const provisioned = provisionedRuntimeForPendingEndpoint(endpoint, now);
  const requested: ObservedRuntime = {
    harness: invocation.execution?.harness?.trim(),
    model: invocation.execution?.model?.trim(),
    reasoningEffort: invocation.execution?.reasoningEffort?.trim(),
  };
  for (const dimension of ["harness", "model", "reasoningEffort"] as const) {
    const expected = requested[dimension];
    if (!expected) continue;
    const actual = observed[dimension];
    if (!actual) {
      const pendingActual = provisioned?.[dimension];
      if (pendingActual) {
        if (pendingActual.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(
            `session_runtime_mismatch: pending session ${endpoint.sessionId ?? endpoint.id} was provisioned with ${dimension} "${pendingActual}", `
              + `but the request requires "${expected}"; omit the session selector to spawn a fresh isolated session`,
          );
        }
        continue;
      }
      throw new Error(
        `session_runtime_unobserved: session ${endpoint.sessionId ?? endpoint.id} has no observed ${dimension}; `
          + "exact runtime requests require a fresh session or an observed match",
      );
    }
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `session_runtime_mismatch: session ${endpoint.sessionId ?? endpoint.id} observed ${dimension} "${actual}", `
          + `but the request requires "${expected}"; omit the session selector to spawn a fresh isolated session`,
      );
    }
  }
}

/**
 * A Scout-owned session has to receive its first invocation before the harness
 * can report observed runtime metadata. During that narrow pending-launch
 * window, the broker may trust the exact configuration it just provisioned.
 * Once the provider attaches (or for any externally sourced endpoint), only
 * observed runtime is authoritative.
 */
export const PENDING_PROVISIONED_RUNTIME_TRUST_MS = 2 * 60_000;

function provisionedRuntimeForPendingEndpoint(
  endpoint: AgentEndpoint,
  now: number,
): ObservedRuntime | undefined {
  const metadata = endpoint.metadata ?? {};
  if (
    metadata.pendingExternalSession !== true
    || metadata.sessionBacked !== true
    || (metadata.source !== "scout-cardless-session" && metadata.source !== "scout-isolated-agent-session")
  ) {
    return undefined;
  }

  const pendingAt = metadataTimestamp(
    metadata.pendingExternalSessionAt ?? metadata.startedAt,
  );
  if (
    !pendingAt
    || pendingAt > now + 30_000
    || now - pendingAt >= PENDING_PROVISIONED_RUNTIME_TRUST_MS
  ) {
    return undefined;
  }

  const stringValue = (value: unknown): string | undefined => (
    typeof value === "string" && value.trim() ? value.trim() : undefined
  );
  const resolution = metadata.executionResolution;
  const resolutionRecord = resolution && typeof resolution === "object" && !Array.isArray(resolution)
    ? resolution as Record<string, unknown>
    : {};
  const resolvedDimension = (dimension: keyof ObservedRuntime): string | undefined => {
    const value = resolutionRecord[dimension];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return stringValue((value as Record<string, unknown>).resolved);
  };

  return {
    harness: stringValue(endpoint.harness) ?? resolvedDimension("harness"),
    model: stringValue(metadata.model) ?? resolvedDimension("model"),
    reasoningEffort: stringValue(metadata.reasoningEffort) ?? resolvedDimension("reasoningEffort"),
  };
}

function metadataTimestamp(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function isWakeableSessionBackedEndpoint(endpoint: AgentEndpoint): boolean {
  return endpoint.metadata?.sessionBacked === true
    && endpoint.state !== "offline"
    && isBrokerRunnableLocalAgentTransport(endpoint.transport);
}
