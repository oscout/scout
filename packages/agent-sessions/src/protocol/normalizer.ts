// SCO-042 harness event normalizer contracts.
//
// Normalizers are pure after construction: no filesystem, process, network,
// environment, clock, stdin, or stdout access. Live adapter shells own those
// side effects and pass semantic edges as adapter_control records.

import type { Action, AgentSessionStreamEvent } from "./primitives.js";

export type AdapterControlEvent =
  | "prompt_accepted"
  | "question_answered"
  | "topology_observed"
  | "interrupt"
  | "transport_closed"
  | "transport_error";

export type AdapterReplayRecord =
  | { source: "harness"; sequence: number; payload: unknown }
  | {
      source: "adapter_control";
      sequence: number;
      event: AdapterControlEvent;
      turnId?: string;
      payload?: unknown;
    };

export type NormalizerIdKind = "turn" | "block" | "event";

export interface HarnessEventNormalizerContext {
  sessionId: string;
  now(): string;
  nextId(kind: NormalizerIdKind): string;
}

export interface HarnessEventNormalizer {
  ingest(record: AdapterReplayRecord): readonly AgentSessionStreamEvent[];
  finishReplay(): readonly AgentSessionStreamEvent[];
  readonly turnOpen: boolean;
}

/** Maximum UTF-8 size for a serialized session event (SCO-042-C009). */
export const MAX_SESSION_EVENT_UTF8_BYTES = 64 * 1024;

/** Maximum retained UTF-8 action output per block in StateTracker (SCO-042-C009). */
export const MAX_RETAINED_ACTION_OUTPUT_UTF8_BYTES = 64 * 1024;

/** Leaves enough envelope space for a serialized action-output event to stay below 64 KiB. */
export const MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES = 60 * 1024;

/** Maximum UTF-8 size for a diagnostic message (SCO-042-C009). */
export const MAX_DIAGNOSTIC_UTF8_BYTES = 4 * 1024;

/** Maximum serialized action value before large inline strings are reduced. */
export const MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES = 48 * 1024;

/** Maximum retained bytes for one structured action string field. */
export const MAX_INLINE_ACTION_TEXT_UTF8_BYTES = 4 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; omittedBytes: number } {
  if (maxBytes <= 0) {
    return { text: "", omittedBytes: utf8ByteLength(value) };
  }
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { text: value, omittedBytes: 0 };
  }
  const slice = encoded.subarray(0, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = slice.byteLength;
  let text = "";
  while (end > 0) {
    try {
      text = decoder.decode(slice.subarray(0, end));
      break;
    } catch {
      // A UTF-8 scalar is at most four bytes, so a cut sequence takes at most
      // three decrements to remove without introducing a replacement glyph.
      end -= 1;
    }
  }
  return {
    text,
    omittedBytes: encoded.byteLength - utf8ByteLength(text),
  };
}

/**
 * Split one textual payload into the largest serialized events that satisfy
 * C009. Measuring the completed JSON envelope also handles quotes, control
 * characters, and other text whose JSON representation is larger than its
 * source UTF-8 representation.
 */
export function splitTextForSessionEvents<T>(
  value: string,
  buildEvent: (text: string) => T,
  maxSerializedBytes = MAX_SESSION_EVENT_UTF8_BYTES,
): T[] {
  if (!value) return [];
  if (utf8ByteLength(JSON.stringify(buildEvent(value))) <= maxSerializedBytes) {
    return [buildEvent(value)];
  }

  const events: T[] = [];
  let remaining = value;
  while (remaining) {
    let low = 1;
    let high = utf8ByteLength(remaining);
    let best = "";

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = truncateUtf8(remaining, mid).text;
      if (!candidate) {
        low = mid + 1;
        continue;
      }
      const encoded = utf8ByteLength(JSON.stringify(buildEvent(candidate)));
      if (encoded <= maxSerializedBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (!best) {
      throw new Error("Session event envelope leaves no room for a text scalar.");
    }
    events.push(buildEvent(best));
    remaining = remaining.slice(best.length);
  }
  return events;
}

export type BoundedOpaqueValue = {
  truncated: true;
  omittedBytes: number;
  maxRetainedBytes: 0;
  sourceRef: string;
};

/** Replace an oversized opaque value with explicit, source-linked metadata. */
export function boundOpaqueValue(
  value: unknown,
  maxBytes: number,
  sourceRef: string,
): unknown | BoundedOpaqueValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    serialized = String(value);
  }
  const bytes = utf8ByteLength(serialized);
  if (bytes <= maxBytes) return snapshotNormalizedValue(value);
  return {
    truncated: true,
    omittedBytes: bytes,
    maxRetainedBytes: 0,
    sourceRef,
  };
}

/**
 * Bound structured action fields while preserving their semantic variant.
 * Adapters share this rather than creating transport-specific truncation
 * behavior for commands, paths, subagent prompts, or generic tool labels.
 */
export function boundActionInlineText(action: Action, sourceRef: string): Action {
  if (utf8ByteLength(JSON.stringify(action)) <= MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES) {
    return action;
  }
  let omittedBytes = 0;
  const bound = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const result = truncateUtf8(value, MAX_INLINE_ACTION_TEXT_UTF8_BYTES);
    omittedBytes += result.omittedBytes;
    return result.text;
  };

  switch (action.kind) {
    case "command":
      action.command = bound(action.command) ?? "";
      break;
    case "file_change":
      action.path = bound(action.path) ?? "";
      action.diff = bound(action.diff);
      break;
    case "subagent":
      action.agentId = bound(action.agentId) ?? "";
      action.agentName = bound(action.agentName);
      action.prompt = bound(action.prompt);
      break;
    case "tool_call":
      action.toolName = bound(action.toolName) ?? "";
      action.toolCallId = bound(action.toolCallId) ?? "";
      break;
  }
  if (action.approval?.description) {
    action.approval.description = bound(action.approval.description);
  }
  if (omittedBytes > 0) {
    action.truncation = {
      omittedBytes: (action.truncation?.omittedBytes ?? 0) + omittedBytes,
      maxRetainedBytes: MAX_INLINE_ACTION_TEXT_UTF8_BYTES,
      sourceRef,
    };
  }
  return action;
}

/** Emitted protocol values are immutable snapshots, never live normalizer state. */
export function snapshotNormalizedValue<T>(value: T): T {
  return structuredClone(value);
}
