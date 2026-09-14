import type { AgentEndpoint } from "@openscout/protocol";

/**
 * What a harness reported about the session behind a Scout endpoint, read
 * from the harness's own records rather than from Scout's launch flags or a
 * caller's request. `sessionId` is the harness's native id for the process
 * that actually runs in the endpoint's pane; `runtime` carries only the
 * dimensions the harness itself emitted (Claude Code's statusline payload for
 * model and effort, its transcript for the answering model) — a dimension it
 * did not emit is absent, never guessed.
 */
export type LocalEndpointSessionObservation = {
  sessionId: string;
  runtime: {
    harness: string;
    model?: string;
    reasoningEffort?: string;
  };
  runtimeSource: string;
  evidence: Record<string, unknown>;
  observedAt: number;
};

function metadataString(metadata: AgentEndpoint["metadata"] | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Whether a provider identity is absent, pending, or adopted without proof. */
export function endpointSessionIdIsUnverified(endpoint: AgentEndpoint): boolean {
  const metadata = endpoint.metadata ?? {};
  if (metadata.pendingExternalSession === true) return true;
  if (typeof metadata.externalSessionAdoptedAt === "number") return true;
  return !(
    metadataString(metadata, "externalSessionId")
    ?? metadataString(metadata, "threadId")
    ?? metadataString(metadata, "nativeSessionId")
  );
}

/** Clear obsolete provider aliases without removing stable Scout routing handles. */
function providerAliasPatch(endpoint: AgentEndpoint, sessionId: string | null): Record<string, unknown> {
  const metadata = endpoint.metadata ?? {};
  const providerKeys = ["externalSessionId", "threadId", "nativeSessionId"];
  const obsolete = new Set(providerKeys.map((key) => metadataString(metadata, key))
    .filter((value): value is string => Boolean(value) && value !== sessionId));
  const patch: Record<string, unknown> = { externalSessionId: sessionId, threadId: null, nativeSessionId: null };
  for (const key of ["sessionId", "runtimeSessionId", "runtimeInstanceId"]) {
    const value = metadataString(metadata, key);
    if (value && obsolete.has(value) && value !== endpoint.id && value !== endpoint.sessionId) patch[key] = null;
  }
  return patch;
}

/** A failed re-observation must not keep caller-adopted identity or runtime usable. */
export function discardAdoptedSessionEvidence(endpoint: AgentEndpoint): AgentEndpoint {
  if (typeof endpoint.metadata?.externalSessionAdoptedAt !== "number") return endpoint;
  return {
    ...endpoint,
    metadata: {
      ...endpoint.metadata,
      ...providerAliasPatch(endpoint, null),
      // Keep the adoption marker until evidence repairs this record. No new
      // provisioning grace is earned by quarantining an old adoption.
      pendingExternalSession: false,
      observedSessionId: null,
      observedRuntime: null,
      observedHarness: null,
      observedModel: null,
      observedReasoningEffort: null,
      observedRuntimeAt: null,
      observedRuntimeSource: null,
      observedSessionEvidence: null,
    },
  };
}

/**
 * A native observation is authoritative for the current provider identity.
 * Stable Scout handles remain unchanged. A launch/flatDispatch flag does not
 * prove that a different native id continues the previously bound transcript.
 */
export function sessionObservationMetadata(
  endpoint: AgentEndpoint,
  observation: LocalEndpointSessionObservation,
): Record<string, unknown> {
  return {
    ...providerAliasPatch(endpoint, observation.sessionId),
    pendingExternalSession: false,
    externalSessionAdoptedAt: undefined,
    observedSessionId: observation.sessionId,
    observedRuntime: { ...observation.runtime },
    // Clear legacy fallbacks so omitted dimensions cannot revive old runtime.
    observedHarness: null,
    observedModel: null,
    observedReasoningEffort: null,
    observedRuntimeAt: observation.observedAt,
    observedRuntimeSource: observation.runtimeSource,
    observedSessionEvidence: { ...observation.evidence, observedAt: observation.observedAt },
  };
}
