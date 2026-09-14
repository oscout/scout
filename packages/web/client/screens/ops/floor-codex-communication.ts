import type { ObserveEvent, TailEvent } from "../../lib/types.ts";

/** Explicit received-message envelopes, not transcript prose or parent inference. */
export function floorCodexCommunication(event: TailEvent): Pick<ObserveEvent, "communication" | "text" | "kind"> | null {
  if (event.source !== "codex") return null;
  const raw = event.raw as { type?: string; payload?: Record<string, unknown> } | undefined;
  const payload = raw?.payload;
  if (raw?.type !== "response_item" || payload?.type !== "agent_message" || typeof payload.author !== "string" || typeof payload.recipient !== "string") return null;
  const parts = Array.isArray(payload.content) ? payload.content : [];
  const text = parts.flatMap((part) => part && typeof part === "object" && typeof part.text === "string" ? [part.text] : []).join("\n");
  const encrypted = parts.some((part) => part && typeof part === "object" && part.type === "encrypted_content");
  // Codex includes an envelope header in the first text part. Remove only that
  // recognized prefix, preserving the actual readable final-answer body.
  const body = text.replace(/^Message Type: [^\n]+\nTask name: [^\n]+\nSender: [^\n]+\nPayload:\s*/, "").trim();
  return {
    kind: "message",
    text: body || (encrypted ? "Message contents unavailable" : "Message exchanged"),
    communication: { from: payload.author, to: payload.recipient, received: true, bodyAvailable: Boolean(body) },
  };
}
