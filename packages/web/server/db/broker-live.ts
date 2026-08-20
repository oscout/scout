import type { MessageRecord } from "@openscout/protocol";

import type {
  WebBrokerDiagnostics,
  WebBrokerDialogueItem,
  WebBrokerRouteAttempt,
} from "./types/web.ts";

type BrokerDiagnosticsSnapshot = {
  actors: Record<string, { displayName?: string | null } | undefined>;
  messages: Record<string, MessageRecord | undefined>;
  totalMessageCount?: number | null;
  projectionStatus?: "ready" | "degraded" | "disabled" | null;
  messageCoverageIncomplete?: boolean;
};

type BrokerCursor = {
  ts: number;
  id: string;
};

function metadataRecord(message: MessageRecord): Record<string, unknown> {
  return (message.metadata ?? {}) as Record<string, unknown>;
}

function isScoutbotThreadDispatchMetadata(metadata: Record<string, unknown>): boolean {
  return metadata.destinationKind === "scoutbot_thread"
    && metadata.source !== "scoutbot"
    && metadata.generatedBy !== "scoutbot";
}

function isBrokerRoutedMessage(message: MessageRecord): boolean {
  const metadata = metadataRecord(message);
  return metadata.source === "scout-cli"
    || typeof metadata.relayTarget === "string"
    || Array.isArray(metadata.relayTargetIds)
    || typeof metadata.relayChannel === "string"
    || isScoutbotThreadDispatchMetadata(metadata);
}

function isHiddenBrokerTimeoutStatus(message: MessageRecord): boolean {
  if (message.class !== "status" || metadataRecord(message).source !== "broker") return false;
  return message.body.includes("Scout stopped waiting for a synchronous result")
    || message.body.includes("the requester stopped waiting after");
}

function messageTarget(message: MessageRecord): string | null {
  const metadata = metadataRecord(message);
  if (isScoutbotThreadDispatchMetadata(metadata)) {
    return "scoutbot";
  }
  if (typeof metadata.relayTarget === "string" && metadata.relayTarget.trim()) {
    return metadata.relayTarget.trim();
  }
  if (Array.isArray(metadata.relayTargetIds)) {
    const targets = metadata.relayTargetIds
      .map((target) => typeof target === "string" ? target.trim() : "")
      .filter(Boolean);
    return targets.length > 0 ? targets.join(", ") : null;
  }
  return null;
}

function messageRoute(message: MessageRecord): string | null {
  const metadata = metadataRecord(message);
  if (isScoutbotThreadDispatchMetadata(metadata)) {
    return "dm";
  }
  return typeof metadata.relayChannel === "string" && metadata.relayChannel.trim()
    ? metadata.relayChannel.trim()
    : null;
}

function compactBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function actorName(snapshot: BrokerDiagnosticsSnapshot, actorId: string): string {
  return snapshot.actors[actorId]?.displayName?.trim() || actorId;
}

function messageActorName(
  snapshot: BrokerDiagnosticsSnapshot,
  message: MessageRecord,
  fallbackName?: string | null,
): string {
  const registeredName = actorName(snapshot, message.actorId);
  if (registeredName !== message.actorId) return registeredName;

  const metadata = metadataRecord(message);
  const returnAddress = metadata.returnAddress;
  if (returnAddress && typeof returnAddress === "object" && !Array.isArray(returnAddress)) {
    const address = returnAddress as Record<string, unknown>;
    const addressActorId = typeof address.actorId === "string" ? address.actorId.trim() : "";
    const displayName = typeof address.displayName === "string" ? address.displayName.trim() : "";
    if (displayName && (!addressActorId || addressActorId === message.actorId)) {
      return displayName;
    }
  }

  const responderName = typeof metadata.responderAgentName === "string"
    ? metadata.responderAgentName.trim()
    : "";
  if (responderName) return responderName;
  const requesterName = typeof metadata.requesterDisplayName === "string"
    ? metadata.requesterDisplayName.trim()
    : "";
  return requesterName || fallbackName?.trim() || message.actorId;
}

function dialogueItem(
  snapshot: BrokerDiagnosticsSnapshot,
  message: MessageRecord,
  fallbackActorName?: string | null,
): WebBrokerDialogueItem {
  return {
    id: message.id,
    ts: message.createdAt,
    actorName: messageActorName(snapshot, message, fallbackActorName),
    conversationId: message.conversationId,
    body: message.body,
    class: message.class,
  };
}

function routedAttempt(
  snapshot: BrokerDiagnosticsSnapshot,
  message: MessageRecord,
  fallbackActorName?: string | null,
): WebBrokerRouteAttempt | null {
  if (!isBrokerRoutedMessage(message)) {
    return null;
  }
  const metadata = metadataRecord(message);
  return {
    id: `message:${message.id}`,
    kind: "success",
    status: "sent",
    ts: message.createdAt,
    actorName: messageActorName(snapshot, message, fallbackActorName),
    target: messageTarget(message),
    route: messageRoute(message) ?? "unknown",
    detail: compactBody(message.body),
    conversationId: message.conversationId,
    messageId: message.id,
    deliveryId: null,
    invocationId: null,
    metadata: {
      source: "messages",
      actorId: message.actorId,
      class: message.class,
      raw: metadata,
    },
  };
}

function decodeCursor(value: string | null | undefined): BrokerCursor | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const ts = Number(trimmed.slice(0, separator));
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const rawId = trimmed.slice(separator + 1);
  try {
    const id = decodeURIComponent(rawId);
    return id ? { ts, id } : null;
  } catch {
    return rawId ? { ts, id: rawId } : null;
  }
}

function encodeCursor(item: { ts: number; id: string } | undefined): string | null {
  return item ? `${item.ts}:${encodeURIComponent(item.id)}` : null;
}

function compareRows(left: { ts: number; id: string }, right: { ts: number; id: string }): number {
  return right.ts - left.ts || left.id.localeCompare(right.id);
}

function isAfterCursor(item: { ts: number; id: string }, cursor: BrokerCursor | null): boolean {
  return !cursor || item.ts < cursor.ts || (item.ts === cursor.ts && item.id > cursor.id);
}

function dedupeRows<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

export function markBrokerDiagnosticsLiveUnavailable(
  projection: WebBrokerDiagnostics,
): WebBrokerDiagnostics {
  return {
    ...projection,
    source: {
      mode: "sqlite_projection",
      status: "degraded",
      latestMessageAt: projection.source?.latestMessageAt ?? projection.dialogue[0]?.ts ?? null,
      projectionLatestMessageAt: projection.source?.projectionLatestMessageAt
        ?? projection.dialogue[0]?.ts
        ?? null,
      liveMessageCount: null,
      projectionMessageCount: projection.source?.projectionMessageCount ?? null,
      detail: "The live broker message feed is unavailable. Showing SQLite projection data, which may be stale.",
    },
  };
}

/**
 * The compact broker feed is capped. It is sufficient when it reaches both
 * the health window and the newest SQLite row; otherwise a complete snapshot
 * is required to avoid a pagination gap or undercounted window totals.
 */
export function brokerDiagnosticsNeedsFullSnapshot(
  projection: WebBrokerDiagnostics,
  snapshot: BrokerDiagnosticsSnapshot,
  now = Date.now(),
): boolean {
  const messages = Object.values(snapshot.messages)
    .filter((message): message is MessageRecord => Boolean(message));
  const totalMessageCount = snapshot.totalMessageCount;
  const compactFeedMayBeTruncated = totalMessageCount === null || totalMessageCount === undefined
    ? messages.length >= 500
    : totalMessageCount > messages.length;
  if (!compactFeedMayBeTruncated) return false;

  const oldestMessageAt = messages.reduce(
    (oldest, message) => Math.min(oldest, message.createdAt),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(oldestMessageAt)) return true;
  const projectionLatestMessageAt = projection.source?.projectionLatestMessageAt
    ?? projection.dialogue[0]?.ts
    ?? null;
  const coversWindow = oldestMessageAt <= now - projection.windowMs;
  const overlapsProjection = projectionLatestMessageAt !== null
    && oldestMessageAt <= projectionLatestMessageAt;
  return !coversWindow || !overlapsProjection;
}

/**
 * Overlay canonical broker message rows onto the SQLite diagnostics. Older
 * projection rows remain as a pagination fallback once the live feed overlaps
 * the projection; failure rows remain projection-backed until the broker has a
 * dedicated global diagnostics read model.
 */
export function mergeBrokerDiagnosticsWithLiveSnapshot(
  projection: WebBrokerDiagnostics,
  snapshot: BrokerDiagnosticsSnapshot,
  cursorValue?: string | null,
): WebBrokerDiagnostics {
  const cursor = decodeCursor(cursorValue);
  const limit = projection.ledger.limit;
  const messages = Object.values(snapshot.messages)
    .filter((message): message is MessageRecord => Boolean(message))
    .filter((message) => !isHiddenBrokerTimeoutStatus(message))
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));

  const projectionDialogueNames = new Map(
    projection.dialogue.map((item) => [item.id, item.actorName] as const),
  );
  const projectionAttemptNames = new Map(
    projection.attempts
      .filter((attempt) => attempt.messageId)
      .map((attempt) => [attempt.messageId as string, attempt.actorName] as const),
  );
  const liveDialogue = messages
    .map((message) => dialogueItem(snapshot, message, projectionDialogueNames.get(message.id)))
    .filter((item) => isAfterCursor(item, cursor));
  const liveAttempts = messages
    .map((message) => routedAttempt(snapshot, message, projectionAttemptNames.get(message.id)))
    .filter((attempt): attempt is WebBrokerRouteAttempt => Boolean(attempt))
    .filter((attempt) => isAfterCursor(attempt, cursor));
  const projectionAttempts = projection.attempts.filter((attempt) => isAfterCursor(attempt, cursor));
  const mergedAttempts = dedupeRows([...liveAttempts, ...projectionAttempts])
    .sort(compareRows);
  const projectionDialogue = projection.dialogue.filter((item) => isAfterCursor(item, cursor));
  const mergedDialogue = dedupeRows([...liveDialogue, ...projectionDialogue])
    .sort(compareRows);
  const attemptRows = mergedAttempts.slice(0, limit);
  const dialogueRows = mergedDialogue.slice(0, limit);

  const now = Date.now();
  const since = now - projection.windowMs;
  const successfulDispatches = messages.filter(
    (message) => message.createdAt >= since && isBrokerRoutedMessage(message),
  ).length;
  const dialogueMessages = messages.filter((message) => message.createdAt >= since).length;
  const failureCount = projection.totals.failedQueries
    + projection.totals.failedDeliveries
    + projection.totals.failedDeliveryAttempts;
  const attemptCount = successfulDispatches + failureCount;
  const hours = Math.max(projection.windowMs / 3_600_000, 1);

  const latestMessageAt = messages[0]?.createdAt ?? null;
  const projectionLatestMessageAt = projection.source?.projectionLatestMessageAt
    ?? projection.dialogue[0]?.ts
    ?? null;
  const projectionMessageCount = projection.source?.projectionMessageCount ?? null;
  const liveMessageCount = snapshot.totalMessageCount ?? messages.length;
  const messageCountMismatch = projectionMessageCount !== null
    && projectionMessageCount !== liveMessageCount;
  const projectionUnavailable = snapshot.projectionStatus !== null
    && snapshot.projectionStatus !== undefined
    && snapshot.projectionStatus !== "ready";
  const projectionBehind = Boolean(snapshot.messageCoverageIncomplete)
    || projectionUnavailable
    || messageCountMismatch
    || (latestMessageAt !== null
      && (projectionLatestMessageAt === null || latestMessageAt > projectionLatestMessageAt));

  return {
    ...projection,
    generatedAt: now,
    source: {
      mode: "live_broker",
      status: projectionBehind ? "degraded" : "current",
      latestMessageAt,
      projectionLatestMessageAt,
      liveMessageCount,
      projectionMessageCount,
      detail: projectionBehind
        ? snapshot.messageCoverageIncomplete
          ? "Live broker messages are current, but older message history and SQLite-backed failure diagnostics may be incomplete."
          : "Live broker messages are current. SQLite-backed failure diagnostics are behind and may be incomplete."
        : null,
    },
    ledger: {
      ...projection.ledger,
      cursor: cursorValue ?? null,
      cursors: {
        ...projection.ledger.cursors,
        attempts: encodeCursor(attemptRows.at(-1)),
        dialogue: encodeCursor(dialogueRows.at(-1)),
      },
      hasMore: {
        ...projection.ledger.hasMore,
        attempts: mergedAttempts.length > limit || projection.ledger.hasMore.attempts,
        dialogue: mergedDialogue.length > limit || projection.ledger.hasMore.dialogue,
      },
    },
    totals: {
      ...projection.totals,
      successfulDispatches,
      dialogueMessages,
    },
    rates: {
      ...projection.rates,
      messagesPerHour: Number((dialogueMessages / hours).toFixed(1)),
      failureRate: attemptCount > 0 ? Number((failureCount / attemptCount).toFixed(3)) : 0,
    },
    attempts: attemptRows,
    dialogue: dialogueRows,
  };
}
