import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type AgentEndpoint, epochMs } from "@openscout/protocol";

export type EndpointPreference = {
  harness?: string | null;
  transport?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  projectRoot?: string | null;
};

export function endpointMetadataRecord(endpoint: AgentEndpoint | null | undefined): Record<string, unknown> {
  return endpoint?.metadata && typeof endpoint.metadata === "object" && !Array.isArray(endpoint.metadata)
    ? endpoint.metadata
    : {};
}

function metadataTimestampMs(value: unknown): number | null {
  return epochMs(value);
}

function endpointFreshnessMs(endpoint: AgentEndpoint): number {
  const metadata = endpointMetadataRecord(endpoint);
  return Math.max(
    metadataTimestampMs(metadata.lastSeenAt) ?? 0,
    metadataTimestampMs(metadata.lastEnsuredAt) ?? 0,
    metadataTimestampMs(metadata.lastStartedAt) ?? 0,
    metadataTimestampMs(metadata.startedAt) ?? 0,
    metadataTimestampMs(metadata.lastCompletedAt) ?? 0,
    metadataTimestampMs(metadata.lastFailedAt) ?? 0,
  );
}

function normalizedComparableString(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizedSessionAlias(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

export function endpointSessionAliases(endpoint: AgentEndpoint): Set<string> {
  const metadata = endpointMetadataRecord(endpoint);
  return new Set([
    endpoint.sessionId,
    metadata.externalSessionId,
    metadata.threadId,
    metadata.nativeSessionId,
    metadata.pairingSessionId,
    metadata.sessionId,
    metadata.runtimeSessionId,
    metadata.runtimeInstanceId,
    metadata.tmuxSession,
  ].map(normalizedSessionAlias).filter((alias): alias is string => Boolean(alias)));
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function normalizedPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? resolve(expandHomePath(trimmed)) : null;
}

function endpointMatchesPreferencePath(endpoint: AgentEndpoint, preference: EndpointPreference | undefined): boolean {
  const preferredPaths = new Set([
    normalizedPath(preference?.cwd),
    normalizedPath(preference?.projectRoot),
  ].filter((path): path is string => Boolean(path)));
  if (preferredPaths.size === 0) {
    return false;
  }
  return [
    normalizedPath(endpoint.cwd),
    normalizedPath(endpoint.projectRoot),
  ].some((path) => Boolean(path && preferredPaths.has(path)));
}

export function selectPreferredAgentEndpoint(
  snapshot: { endpoints?: Record<string, AgentEndpoint> },
  agentId: string,
  preference?: EndpointPreference,
): AgentEndpoint | null {
  const candidates = Object.values(snapshot.endpoints ?? {}).filter(
    (endpoint) => endpoint.agentId === agentId,
  );
  const rank = (state: string | undefined) => {
    switch (state) {
      case "active":
        return 0;
      case "idle":
        return 1;
      case "waiting":
        return 2;
      case "offline":
        return 5;
      default:
        return 4;
    }
  };

  const preferredHarness = normalizedComparableString(preference?.harness);
  const preferredTransport = normalizedComparableString(preference?.transport);
  const preferredSessionId = normalizedSessionAlias(preference?.sessionId);
  const compare = (left: AgentEndpoint, right: AgentEndpoint) => {
    const leftMetadata = endpointMetadataRecord(left);
    const rightMetadata = endpointMetadataRecord(right);
    const leftTuple = [
      leftMetadata.staleLocalRegistration === true ? 1 : 0,
      preferredSessionId ? (endpointSessionAliases(left).has(preferredSessionId) ? 0 : 1) : 0,
      preferredHarness ? (normalizedComparableString(left.harness) === preferredHarness ? 0 : 1) : 0,
      preferredTransport ? (normalizedComparableString(left.transport) === preferredTransport ? 0 : 1) : 0,
      endpointMatchesPreferencePath(left, preference) ? 0 : 1,
      rank(left.state),
      -endpointFreshnessMs(left),
    ];
    const rightTuple = [
      rightMetadata.staleLocalRegistration === true ? 1 : 0,
      preferredSessionId ? (endpointSessionAliases(right).has(preferredSessionId) ? 0 : 1) : 0,
      preferredHarness ? (normalizedComparableString(right.harness) === preferredHarness ? 0 : 1) : 0,
      preferredTransport ? (normalizedComparableString(right.transport) === preferredTransport ? 0 : 1) : 0,
      endpointMatchesPreferencePath(right, preference) ? 0 : 1,
      rank(right.state),
      -endpointFreshnessMs(right),
    ];
    for (let index = 0; index < leftTuple.length; index += 1) {
      const leftValue = leftTuple[index]!;
      const rightValue = rightTuple[index]!;
      if (leftValue < rightValue) {
        return -1;
      }
      if (leftValue > rightValue) {
        return 1;
      }
    }
    return left.id.localeCompare(right.id);
  };

  return [...candidates].sort(compare)[0] ?? null;
}
