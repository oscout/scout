import { brokerAttemptTone } from "../../lib/status-tone.ts";
import { SCOUTBOT_SUBMIT_EVENT } from "../../lib/scoutbot.ts";
import type { Agent, BrokerRouteAttempt } from "../../lib/types.ts";

const FAILURE_DETAIL_CHARS = 220;
const SUCCESS_DETAIL_CHARS = 92;

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedAgentAddress(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function agentMatchesAddress(agent: Agent, address: string): boolean {
  const needle = normalizedAgentAddress(address);
  return [
    agent.id,
    agent.name,
    agent.handle,
    agent.selector,
    agent.defaultSelector,
    agent.conversationId,
    agent.harnessSessionId,
  ].some((candidate) => candidate && normalizedAgentAddress(candidate) === needle);
}

function appendAddressCandidate(candidates: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    candidates.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendAddressCandidate(candidates, item);
  }
}

/**
 * Resolve the concrete agent a Dispatch row actually addressed. Broker rows can
 * use a session id as their visible target while keeping the stable agent name
 * only in relay metadata, so checking `attempt.target` alone is insufficient.
 * Candidate ordering intentionally keeps the visible/canonical destination
 * ahead of labels copied into ancillary metadata.
 */
export function brokerAttemptTargetAgent(
  attempt: BrokerRouteAttempt,
  agents: Agent[],
): Agent | null {
  const metadata = attempt.metadata ?? {};
  const raw = readRecord(metadata.raw);
  const candidates: string[] = [];

  appendAddressCandidate(candidates, attempt.target);
  for (const key of ["targetAgentId", "targetId", "targetSessionId", "relayTarget", "relayTargetIds"] as const) {
    appendAddressCandidate(candidates, metadata[key]);
  }
  if (raw) {
    for (const key of ["targetAgentId", "targetSessionId", "relayTarget", "relayTargetIds", "targetId"] as const) {
      appendAddressCandidate(candidates, raw[key]);
    }
  }
  for (const key of ["targetDisplayName", "targetLabel"] as const) {
    appendAddressCandidate(candidates, metadata[key]);
    if (raw) appendAddressCandidate(candidates, raw[key]);
  }

  for (const candidate of new Set(candidates.map(normalizedAgentAddress))) {
    const agent = agents.find((entry) => agentMatchesAddress(entry, candidate));
    if (agent) return agent;
  }
  return null;
}

function normalizeFingerprintPart(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = readString(metadata?.[key]);
    if (value) return value;
  }
  return null;
}

function rawDeliveryMetadata(attempt: BrokerRouteAttempt): Record<string, unknown> | null {
  const metadata = attempt.metadata ?? {};
  const raw = readRecord(metadata.raw);
  const delivery = readRecord(raw?.delivery);
  return readRecord(delivery?.metadata);
}

export function clippedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function brokerAttemptIsFailure(attempt: BrokerRouteAttempt): boolean {
  return brokerAttemptTone(attempt.kind, attempt.status) === "danger"
    || attempt.status === "error";
}

export function brokerAttemptFailureTitle(attempt: BrokerRouteAttempt): string {
  if (attempt.kind === "failed_query") {
    switch (metadataString(attempt.metadata, "dispatchKind")) {
      case "unknown":
        return "Target not found";
      case "ambiguous":
        return "Target is ambiguous";
      case "unparseable":
        return "Invalid target";
      default:
        return "Route not resolved";
    }
  }

  const reason = metadataString(
    attempt.metadata,
    "failureReason",
    "reconciledReason",
    "reason",
  );
  if (reason === "agent_offline" || reason === "agent_unreachable") return "Agent unavailable";
  if (reason === "peer_unreachable" || reason === "local_socket_unreachable") return "Route unavailable";
  if (reason === "peer_rejected") return "Delivery rejected";
  return "Delivery failed";
}

/**
 * Turn the broker's attempt-oriented diagnostics into a message-oriented feed.
 * A routed message is the primary row; a linked terminal delivery failure is
 * folded into it so the operator sees the message once with its final outcome.
 * Transport retries stay available in metadata/diagnostics instead of reading
 * like additional messages on the Dispatch home surface.
 */
export function brokerMessageFeedRows(attempts: BrokerRouteAttempt[]): BrokerRouteAttempt[] {
  const messagesById = new Map<string, BrokerRouteAttempt>();
  const failuresByMessageId = new Map<string, BrokerRouteAttempt>();

  for (const attempt of attempts) {
    if (!attempt.messageId) continue;
    if (attempt.kind === "success") {
      if (!messagesById.has(attempt.messageId)) messagesById.set(attempt.messageId, attempt);
    } else if (attempt.kind === "failed_delivery") {
      const current = failuresByMessageId.get(attempt.messageId);
      if (!current || attempt.ts > current.ts) failuresByMessageId.set(attempt.messageId, attempt);
    }
  }

  const rows: BrokerRouteAttempt[] = [];
  for (const attempt of attempts) {
    if (attempt.kind === "delivery_attempt") continue;

    if (attempt.kind === "failed_delivery" && attempt.messageId && messagesById.has(attempt.messageId)) {
      continue;
    }

    if (attempt.kind === "success" && attempt.messageId) {
      const failure = failuresByMessageId.get(attempt.messageId);
      if (failure) {
        rows.push({
          ...failure,
          id: attempt.id,
          ts: attempt.ts,
          actorName: attempt.actorName,
          target: attempt.target ?? failure.target,
          route: attempt.route ?? failure.route,
          detail: attempt.detail,
          conversationId: attempt.conversationId ?? failure.conversationId,
          messageId: attempt.messageId,
          invocationId: attempt.invocationId ?? failure.invocationId,
          metadata: {
            ...(failure.metadata ?? {}),
            message: attempt.metadata ?? null,
          },
        });
        continue;
      }
    }

    rows.push(attempt);
  }

  return rows.sort((left, right) => right.ts - left.ts || left.id.localeCompare(right.id));
}

export function brokerAttemptDetailLimit(attempt: BrokerRouteAttempt): number {
  return brokerAttemptIsFailure(attempt) ? FAILURE_DETAIL_CHARS : SUCCESS_DETAIL_CHARS;
}

export function brokerAttemptErrorSummary(attempt: BrokerRouteAttempt): string | null {
  if (!brokerAttemptIsFailure(attempt)) return null;

  if (attempt.kind === "failed_query") {
    return brokerAttemptFailureTitle(attempt);
  }

  const metadata = attempt.metadata ?? {};
  const transportReason = readString(metadata.reason);
  const reason = readString(metadata.failureDetail)
    ?? readString(metadata.failureReason)
    ?? (attempt.kind === "failed_delivery" && ["direct_message", "mention"].includes(transportReason ?? "")
      ? null
      : transportReason)
    ?? readString(metadata.error);
  const requestedLabel = readString(metadata.requestedLabel);

  const parts: string[] = [];
  if (attempt.status && attempt.status !== "failed" && attempt.status !== "error") {
    parts.push(attempt.status);
  }
  if (reason && reason !== attempt.detail.trim()) parts.push(reason);
  if (requestedLabel && !attempt.detail.includes(requestedLabel)) parts.push(`asked ${requestedLabel}`);

  return parts.length > 0 ? [...new Set(parts)].join(" · ") : null;
}

export function formatMetadataScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const METADATA_SUMMARY_KEYS = [
  "source",
  "deliveryId",
  "messageId",
  "conversationId",
  "invocationId",
  "dispatchKind",
  "reason",
  "error",
  "requestedLabel",
  "requesterId",
  "targetId",
  "transport",
  "failureReason",
  "failureDetail",
  "reconciledReason",
  "attempt",
  "class",
  "actorId",
  "dispatchId",
  "attemptId",
] as const;

export type BrokerMetadataSummaryEntry = {
  key: string;
  value: string;
};

export function brokerMetadataSummary(
  metadata: Record<string, unknown> | null | undefined,
): BrokerMetadataSummaryEntry[] {
  if (!metadata) return [];

  const entries: BrokerMetadataSummaryEntry[] = [];
  const seen = new Set<string>();

  for (const key of METADATA_SUMMARY_KEYS) {
    if (!(key in metadata) || !isScalar(metadata[key])) continue;
    entries.push({ key, value: formatMetadataScalar(metadata[key]) });
    seen.add(key);
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (key === "raw" || seen.has(key) || !isScalar(value)) continue;
    entries.push({ key, value: formatMetadataScalar(value) });
  }

  return entries;
}

export function brokerAttemptDedupeFingerprint(attempt: BrokerRouteAttempt): string {
  const metadata = attempt.metadata ?? {};
  const messageId = attempt.messageId ?? metadataString(metadata, "messageId");
  const target = attempt.target ?? metadataString(metadata, "targetId");
  const transport = attempt.route ?? metadataString(metadata, "transport");
  if (attempt.kind === "failed_delivery" && messageId && target && transport) {
    return ["failed_delivery", messageId, target, transport].join("|");
  }

  return [
    attempt.kind,
    messageId ?? attempt.deliveryId ?? attempt.invocationId ?? attempt.id,
    target,
    transport,
    metadataString(metadata, "failureReason", "reconciledReason", "reason", "error") ?? attempt.detail,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(normalizeFingerprintPart)
    .join("|");
}

export function brokerAttemptRootCauseFingerprint(attempt: BrokerRouteAttempt): string {
  const metadata = attempt.metadata ?? {};
  const deliveryMetadata = rawDeliveryMetadata(attempt);
  return [
    attempt.kind,
    attempt.target ?? metadataString(metadata, "targetId"),
    attempt.route ?? metadataString(metadata, "transport"),
    metadataString(metadata, "failureReason", "reconciledReason", "error")
      ?? metadataString(deliveryMetadata, "failureReason", "reconciledReason", "error")
      ?? attempt.status,
    metadataString(metadata, "failureDetail")
      ?? metadataString(deliveryMetadata, "failureDetail")
      ?? metadataString(metadata, "reason")
      ?? attempt.detail,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => normalizeFingerprintPart(value).toLowerCase())
    .join("|");
}

export function brokerAttemptContextJson(attempt: BrokerRouteAttempt): Record<string, unknown> {
  return {
    copiedAt: new Date().toISOString(),
    dedupeFingerprint: brokerAttemptDedupeFingerprint(attempt),
    rootCauseFingerprint: brokerAttemptRootCauseFingerprint(attempt),
    sourceEndpoint: "/api/broker?limit=160",
    reviewEndpoint: "/api/broker/dispatch-review",
    attempt,
  };
}

export function brokerAttemptContextText(attempt: BrokerRouteAttempt): string {
  const context = brokerAttemptContextJson(attempt);
  const lines = [
    brokerAttemptIsFailure(attempt)
      ? "OpenScout dispatch failure context"
      : "OpenScout dispatch context",
    "",
    `id: ${attempt.id}`,
    `kind: ${attempt.kind}`,
    `status: ${attempt.status}`,
    `time: ${new Date(attempt.ts).toISOString()}`,
    `target: ${attempt.target ?? "none"}`,
    `transport/route: ${attempt.route ?? "none"}`,
    `messageId: ${attempt.messageId ?? "none"}`,
    `deliveryId: ${attempt.deliveryId ?? "none"}`,
    `invocationId: ${attempt.invocationId ?? "none"}`,
    `conversationId: ${attempt.conversationId ?? "none"}`,
    `detail: ${attempt.detail}`,
    `dedupeFingerprint: ${context.dedupeFingerprint}`,
    `rootCauseFingerprint: ${context.rootCauseFingerprint}`,
    "",
    "Full JSON:",
    JSON.stringify(context, null, 2),
  ];
  return lines.join("\n");
}

/**
 * Include the inspected snapshot because message-oriented Dispatch rows can be
 * synthesized from several broker records and therefore may not have a raw
 * diagnostics attempt id of their own.
 */
export function brokerDispatchReviewRequest(attempt: BrokerRouteAttempt): {
  attemptId: string;
  attempt: BrokerRouteAttempt;
} {
  return {
    attemptId: attempt.id,
    attempt,
  };
}

export function brokerScoutbotTriageRequest(attempt: BrokerRouteAttempt): {
  eventName: typeof SCOUTBOT_SUBMIT_EVENT;
  body: string;
} {
  return {
    eventName: SCOUTBOT_SUBMIT_EVENT,
    body: [
      "Review and triage this failed dispatch.",
      "Determine the likely root cause, decide whether it needs action or can be dismissed as transient, and report your verdict and recommended next step.",
      "Use the context below; if the evidence is incomplete, state what remains uncertain.",
      "",
      brokerAttemptContextText(attempt),
    ].join("\n"),
  };
}

export function brokerMetadataPayload(
  metadata: Record<string, unknown> | null | undefined,
): unknown | null {
  if (!metadata) return null;
  if (metadata.raw !== undefined && metadata.raw !== null) return metadata.raw;

  const nested = Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) => key !== "raw" && !isScalar(value)),
  );
  return Object.keys(nested).length > 0 ? nested : null;
}

export function brokerMetadataJson(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) return "{}";
  return JSON.stringify(metadata, null, 2);
}
