import { refreshSessionAuth } from "./api.ts";
import type { ScoutbotAssistantReply } from "../scout/scoutbot/scoutbot-model.ts";

/**
 * Streaming client for `POST /api/scoutbot/chat` with `stream: true`.
 *
 * The server emits SSE events: `sentence` (`{"text": string}`) in arrival
 * order while the reply generates, exactly one `final` with the same payload
 * the non-streaming endpoint returns (voiceTurn echo included), or one
 * `error` (`{"error": string, "status": number}`) instead of `final`. The
 * stream closes after `final` or `error`; this resolves once it does.
 */

export type ScoutbotChatStreamFinal = ScoutbotAssistantReply & {
  voiceTurn?: { turn: number; gen: number };
};

export type ScoutbotChatStreamError = {
  message: string;
  status: number;
};

export type ScoutbotChatStreamEvents = {
  onSentence?: (text: string) => void;
  onFinal?: (reply: ScoutbotChatStreamFinal) => void;
  onError?: (error: ScoutbotChatStreamError) => void;
};

export async function streamScoutbotChat(
  input: {
    body: string;
    route?: unknown;
    uiContext?: unknown;
    voiceTurn?: { turn: number; gen: number };
    signal?: AbortSignal;
  },
  events: ScoutbotChatStreamEvents,
): Promise<void> {
  const performFetch = () => fetch("/api/scoutbot/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      body: input.body,
      route: input.route,
      uiContext: input.uiContext,
      ...(input.voiceTurn ? { voiceTurn: input.voiceTurn } : {}),
      stream: true,
    }),
    signal: input.signal,
  });

  let response = await performFetch();
  if (response.status === 401) {
    const refreshed = await refreshSessionAuth();
    if (refreshed) response = await performFetch();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text || `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error) message = parsed.error;
    } catch {
      /* plain text */
    }
    throw new Error(message);
  }
  if (!response.body) {
    throw new Error("Scoutbot reply stream is unavailable in this browser.");
  }

  let terminal = false;
  const handleEvent = (rawEvent: string) => {
    if (terminal || input.signal?.aborted) return;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === "sentence") {
      if (typeof payload.text === "string" && payload.text) events.onSentence?.(payload.text);
      return;
    }
    if (event === "final") {
      terminal = true;
      events.onFinal?.(payload as unknown as ScoutbotChatStreamFinal);
      return;
    }
    if (event === "error") {
      terminal = true;
      const message = typeof payload.error === "string" && payload.error
        ? payload.error
        : "Scoutbot assistant failed";
      const status = typeof payload.status === "number" && Number.isFinite(payload.status)
        ? payload.status
        : 500;
      events.onError?.({ message, status });
    }
  };

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    while (!terminal && !input.signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const rawEvent = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleEvent(rawEvent);
        index = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
    if (input.signal?.aborted) throw new DOMException("Scoutbot request was cancelled.", "AbortError");
    if (!terminal) throw new Error("Scoutbot reply stream ended before the reply completed.");
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
