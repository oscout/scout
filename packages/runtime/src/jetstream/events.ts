import { createHash } from "node:crypto";

import type { MessageRecord } from "@openscout/protocol";

import { JETSTREAM_SUBJECT_PREFIX } from "./config.js";

/**
 * Event kinds this slice publishes. Deliberately one kind: every additional
 * kind needs its own authority, access, and retention answer, and the proposal
 * requires those before a selector is advertised as supported.
 */
export type ScoutStreamEventKind = "message.posted";

export const SCOUT_STREAM_EVENT_KINDS: readonly ScoutStreamEventKind[] = ["message.posted"];

/** Subject token for a kind: NATS tokens cannot contain `.`. */
const KIND_TOKENS: Record<ScoutStreamEventKind, string> = { "message.posted": "message_posted" };

/**
 * Metadata-only projection of a Scout message.
 *
 * The body is deliberately absent. The first consumer is an invalidation
 * signal, so the stream never needs to hold message text — which keeps private
 * conversation content out of NATS storage entirely. A consumer that needs the
 * body refetches it from Scout under Scout's own authorization.
 */
export type ScoutStreamMessageSummary = {
  id: string;
  conversationId: string;
  parentConversationId: string | null;
  actorId: string;
  createdAt: number;
  class: MessageRecord["class"];
  visibility: MessageRecord["visibility"];
  replyToMessageId: string | null;
  threadConversationId: string | null;
};

export type ScoutStreamEvent = {
  v: 1;
  /** Stable across retries and republished catch-up passes. */
  eventId: string;
  kind: ScoutStreamEventKind;
  ts: number;
  /** The node that authored the source record. */
  originNodeId: string;
  /** The node whose broker published it onto this stream. */
  publisherNodeId: string;
  actorId: string;
  conversationId: string;
  message: ScoutStreamMessageSummary;
};

const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * A deterministic NATS subject token for an arbitrary Scout id.
 *
 * Subjects are routing only — the envelope always carries the true id — but
 * the mapping has to be stable in both directions of use: a publisher and a
 * subscriber must derive the same token for the same conversation.
 */
export function jetStreamToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 0 && trimmed.length <= 96 && SAFE_TOKEN.test(trimmed)) return trimmed;
  return `h${createHash("sha256").update(trimmed).digest("hex").slice(0, 32)}`;
}

export function jetStreamSubject(input: {
  prefix?: string;
  publisherNodeId: string;
  kind: ScoutStreamEventKind;
  conversationId: string;
}): string {
  const prefix = input.prefix ?? JETSTREAM_SUBJECT_PREFIX;
  return [
    prefix,
    jetStreamToken(input.publisherNodeId),
    KIND_TOKENS[input.kind],
    jetStreamToken(input.conversationId),
  ].join(".");
}

/** Wildcard used by the stream itself and by a broad consumer. */
export function jetStreamStreamSubjects(prefix = JETSTREAM_SUBJECT_PREFIX): string[] {
  return [`${prefix}.>`];
}

export function jetStreamFilterSubject(input: {
  prefix?: string;
  publisherNodeId?: string;
  kind?: ScoutStreamEventKind;
  conversationId?: string;
}): string {
  const prefix = input.prefix ?? JETSTREAM_SUBJECT_PREFIX;
  return [
    prefix,
    input.publisherNodeId ? jetStreamToken(input.publisherNodeId) : "*",
    input.kind ? KIND_TOKENS[input.kind] : "*",
    input.conversationId ? jetStreamToken(input.conversationId) : "*",
  ].join(".");
}

/**
 * Stable event identity for `Nats-Msg-Id`.
 *
 * Derived from the source record, never from the attempt: a retry, a restart,
 * and a catch-up rescan of the same journal entry all produce this same id, so
 * JetStream collapses them inside the configured duplicate window.
 */
export function scoutStreamEventId(kind: ScoutStreamEventKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

export function messagePostedStreamEvent(input: {
  message: MessageRecord;
  publisherNodeId: string;
  parentConversationId?: string | null;
}): ScoutStreamEvent {
  const { message } = input;
  return {
    v: 1,
    eventId: scoutStreamEventId("message.posted", message.id),
    kind: "message.posted",
    ts: message.createdAt,
    originNodeId: message.originNodeId,
    publisherNodeId: input.publisherNodeId,
    actorId: message.actorId,
    conversationId: message.conversationId,
    message: {
      id: message.id,
      conversationId: message.conversationId,
      parentConversationId: input.parentConversationId ?? null,
      actorId: message.actorId,
      createdAt: message.createdAt,
      class: message.class,
      visibility: message.visibility,
      replyToMessageId: message.replyToMessageId ?? null,
      threadConversationId: message.threadConversationId ?? null,
    },
  };
}

export function encodeScoutStreamEvent(event: ScoutStreamEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

/** Parse without trusting the stream: a malformed payload is not an event. */
export function decodeScoutStreamEvent(payload: Uint8Array | string): ScoutStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<ScoutStreamEvent>;
  if (candidate.v !== 1) return null;
  if (candidate.kind !== "message.posted") return null;
  if (typeof candidate.eventId !== "string" || candidate.eventId.length === 0) return null;
  if (typeof candidate.conversationId !== "string" || candidate.conversationId.length === 0) {
    return null;
  }
  if (typeof candidate.actorId !== "string") return null;
  if (typeof candidate.originNodeId !== "string") return null;
  if (typeof candidate.publisherNodeId !== "string") return null;
  if (typeof candidate.ts !== "number" || !Number.isFinite(candidate.ts)) return null;
  const message = candidate.message as ScoutStreamMessageSummary | undefined;
  if (!message || typeof message.id !== "string" || typeof message.conversationId !== "string") {
    return null;
  }
  return candidate as ScoutStreamEvent;
}
