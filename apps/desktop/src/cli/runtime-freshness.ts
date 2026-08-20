export const RUNTIME_FRESHNESS_DECISION_KEYS = [
  "state",
  "intentional",
  "basis",
  "reasonCode",
  "detail",
] as const;

export type ScoutdRuntimeFreshnessDecision = {
  state: string;
  intentional: boolean;
  basis: string;
  reasonCode: string | null;
  detail: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads scoutd's runtime verdict without trying to reconstruct it from daemon,
 * broker, or CLI version fields. scoutd owns the artifact comparison and emits
 * this shape from both `status --json` and the nested doctor status.
 */
export function extractRuntimeFreshnessDecisionFromScoutdPayload(
  payload: unknown,
): ScoutdRuntimeFreshnessDecision | null {
  if (!isRecord(payload)) {
    return null;
  }

  const status = isRecord(payload.status) ? payload.status : payload;
  if (!isRecord(status.runtimeFreshness)) {
    return null;
  }

  const freshness = status.runtimeFreshness;
  const state = readNonEmptyString(freshness.state);
  const basis = readNonEmptyString(freshness.basis);
  if (!state || !basis || typeof freshness.intentional !== "boolean") {
    return null;
  }

  return {
    state,
    intentional: freshness.intentional,
    basis,
    reasonCode: readNonEmptyString(freshness.reasonCode),
    detail: readNonEmptyString(freshness.detail),
  };
}

export function shouldRestartBrokerForRuntimeFreshness(
  freshness: ScoutdRuntimeFreshnessDecision | null,
): boolean {
  return (
    freshness?.state === "stale" &&
    freshness.intentional === false &&
    freshness.basis === "installed_artifact"
  );
}
