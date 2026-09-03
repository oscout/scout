import { createHash } from "node:crypto";

import {
  SCOUT_SESSION_HANDLE_PREFIX,
  type AgentEndpoint,
  type ScoutSessionHandle,
} from "@openscout/protocol";

function metadataStringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstStringValue(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => Boolean(value?.trim()))?.trim() ?? null;
}

/**
 * Pick the harness-context alias used to distinguish successive sessions on
 * one endpoint. This is resolver input only and is never exposed as identity.
 */
export function runtimeSessionPrimaryAlias(endpoint: AgentEndpoint): string | null {
  const metadata = endpoint.metadata;
  if (metadata?.cardless === true) {
    return firstStringValue(
      metadataStringValue(metadata, "handle"),
      metadataStringValue(metadata, "externalSessionId"),
      metadataStringValue(metadata, "threadId"),
      endpoint.sessionId,
      endpoint.agentId,
    );
  }
  return firstStringValue(
    metadataStringValue(metadata, "externalSessionId"),
    metadataStringValue(metadata, "threadId"),
    metadataStringValue(metadata, "nativeSessionId"),
    metadataStringValue(metadata, "pairingSessionId"),
    metadataStringValue(metadata, "sessionId"),
    endpoint.sessionId,
    metadataStringValue(metadata, "runtimeSessionId"),
    metadataStringValue(metadata, "runtimeInstanceId"),
    metadataStringValue(metadata, "tmuxSession"),
  );
}

/**
 * Derive the broker's opaque short handle for the current endpoint context.
 * The preimage is deliberately kept behind the resolver; callers see only the
 * fixed-width token and must not infer routing facts from it.
 */
export function runtimeSessionHandleForEndpoint(
  endpoint: AgentEndpoint,
  primaryAlias = runtimeSessionPrimaryAlias(endpoint),
): ScoutSessionHandle | null {
  if (!primaryAlias) return null;
  const resolutionKey = [
    endpoint.nodeId,
    endpoint.harness,
    primaryAlias,
  ].join("\u0000");
  const token = createHash("sha256").update(resolutionKey).digest("hex").slice(0, 20);
  return `${SCOUT_SESSION_HANDLE_PREFIX}${token}`;
}
