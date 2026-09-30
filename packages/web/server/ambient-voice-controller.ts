import {
  extractScoutbotUiActions,
  stripScoutbotUiFences,
  type ScoutbotUiAction,
} from "../client/lib/scoutbot.ts";
import { AmbientTranscriptBuffer, type AmbientExcerpt } from "./ambient-voice.ts";
import type { ScoutVoiceAmbientListener } from "./scout-voice-session.ts";

/**
 * Runs always-on voice: keeps one continuous capture session on the Mac,
 * feeds its finalized segments into the rolling buffer, and on a spoken
 * submit sends the excerpt to Scoutbot and speaks the reply on the Mac.
 *
 * Nothing leaves the machine until a submit, and then only the excerpt. The
 * loop runs in the web server, so no page has to stay open.
 */

export type AmbientVoiceStatus = "off" | "starting" | "listening" | "waiting" | "replying";

export type AmbientVoiceSnapshot = {
  enabled: boolean;
  status: AmbientVoiceStatus;
  buffer: { segmentCount: number; oldestAt: number | null; newestAt: number | null };
  lastSubmit: {
    at: number;
    excerpt: string | null;
    reason: AmbientExcerpt["reason"] | null;
    reply: string | null;
    error: string | null;
  } | null;
  lastError: string | null;
};

/** Page actions from one reply, for whichever open Scout page claims them first. */
export type AmbientPageActions = { id: string; at: number; actions: ScoutbotUiAction[] };

export type AmbientAgentAsk = { targetLabel: string; targetAgentId?: string; body: string; channel?: string };

export type AmbientVoiceDeps = {
  startSession: () => { sessionId: string };
  cancelSession: (sessionId: string) => void;
  /** A push-to-talk dictation holds the mic; always-on waits for it. */
  micBusy: () => boolean;
  /** The Mac is speaking some reply; what the mic hears now is that reply. */
  hostSpeaking: () => boolean;
  respond: (body: string) => Promise<string>;
  speak: (text: string) => Promise<void>;
  askAgent: (ask: AmbientAgentAsk) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
};

const RESTART_DELAY_MS = 3_000;
/** Mic tail after the Mac stops speaking, so the reply isn't heard as speech. */
const ECHO_GRACE_MS = 1_500;
/** An unclaimed page action is stale after this; nobody wants a late jump. */
const PAGE_ACTION_TTL_MS = 30_000;

export const AMBIENT_SUBMIT_PROMPT = [
  "Always-on voice: the operator said the following near their Mac (transcribed on-device) and then handed it to you.",
  "It is loose speech, possibly several thoughts; the end usually says what they want done.",
  "If it names no request, respond to what they said as if they asked you.",
  "Excerpt:",
].join(" ");

export function createAmbientVoiceController(deps: AmbientVoiceDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  });

  let enabled = false;
  let status: AmbientVoiceStatus = "off";
  let sessionId: string | null = null;
  let buffer = new AmbientTranscriptBuffer();
  let replying = false;
  let deafUntil = 0;
  let restartTimer: { cancel: () => void } | null = null;
  let lastSubmit: AmbientVoiceSnapshot["lastSubmit"] = null;
  let lastError: string | null = null;
  const pageSubscribers = new Set<(batch: AmbientPageActions) => void>();
  const unclaimed = new Map<string, number>();
  let pageBatchSeq = 0;

  const publishPageActions = (actions: ScoutbotUiAction[]) => {
    const at = now();
    for (const [id, expires] of unclaimed) if (expires <= at) unclaimed.delete(id);
    pageBatchSeq += 1;
    const batch: AmbientPageActions = { id: `ambient-${at}-${pageBatchSeq}`, at, actions };
    unclaimed.set(batch.id, at + PAGE_ACTION_TTL_MS);
    for (const subscriber of pageSubscribers) subscriber(batch);
  };

  const startListening = () => {
    restartTimer?.cancel();
    restartTimer = null;
    if (!enabled || sessionId) return;
    if (deps.micBusy()) {
      status = "waiting";
      scheduleRestart();
      return;
    }
    try {
      status = "starting";
      sessionId = deps.startSession().sessionId;
      lastError = null;
    } catch (error) {
      sessionId = null;
      status = "waiting";
      lastError = error instanceof Error ? error.message : "Could not start listening.";
      scheduleRestart();
    }
  };

  const scheduleRestart = () => {
    if (!enabled || restartTimer) return;
    restartTimer = setTimer(() => {
      restartTimer = null;
      startListening();
    }, RESTART_DELAY_MS);
  };

  const handleSubmit = async (excerpt: AmbientExcerpt | null, at: number) => {
    const record: NonNullable<AmbientVoiceSnapshot["lastSubmit"]> = {
      at,
      excerpt: excerpt?.text ?? null,
      reason: excerpt?.reason ?? null,
      reply: null,
      error: null,
    };
    lastSubmit = record;
    replying = true;
    status = "replying";
    try {
      if (!excerpt) {
        record.reply = "I didn't catch anything new to send.";
      } else {
        const reply = await deps.respond(`${AMBIENT_SUBMIT_PROMPT}\n"${excerpt.text}"`);
        const actions = extractScoutbotUiActions(reply);
        // Page actions go to an open Scout page; an agent ask needs only the broker.
        const pageActions = actions.filter((action) => action.type !== "ask-agent" && action.type !== "reminder");
        if (pageActions.length > 0) publishPageActions(pageActions);
        for (const action of actions) {
          if (action.type !== "ask-agent") continue;
          await deps.askAgent({
            targetLabel: action.targetLabel,
            ...(action.targetAgentId ? { targetAgentId: action.targetAgentId } : {}),
            body: action.body,
            ...(action.channel ? { channel: action.channel } : {}),
          });
        }
        record.reply = stripScoutbotUiFences(reply);
      }
      if (record.reply) await deps.speak(record.reply);
    } catch (error) {
      record.error = error instanceof Error ? error.message : "Always-on submit failed.";
      await deps.speak("Sorry, that didn't go through.").catch(() => undefined);
    } finally {
      replying = false;
      deafUntil = now() + ECHO_GRACE_MS;
      if (enabled) status = sessionId ? "listening" : "waiting";
    }
  };

  const listener: ScoutVoiceAmbientListener = ({ sessionId: eventSessionId, event, data }) => {
    if (eventSessionId !== sessionId) return;
    if (event === "session.state" && (data.state === "recording" || data.state === "listening")) {
      if (!replying) status = "listening";
      return;
    }
    if (event === "session.cancelled" || event === "session.error"
      || (event === "session.state" && (data.state === "done" || data.state === "cancelled"))) {
      sessionId = null;
      if (event === "session.error" && typeof data.message === "string") lastError = data.message;
      if (enabled && !replying) status = "waiting";
      scheduleRestart();
      return;
    }
    if (event !== "session.segment" && event !== "session.partial") return;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) return;
    const at = typeof data.at === "number" && Number.isFinite(data.at) ? data.at : now();
    if (replying || at < deafUntil) return;
    if (deps.hostSpeaking()) {
      deafUntil = now() + ECHO_GRACE_MS;
      return;
    }
    const result = event === "session.partial"
      ? buffer.pushPartial({ text, at })
      : buffer.push({ text, at });
    if (result) void handleSubmit(result.excerpt, at);
  };

  return {
    listener,
    setEnabled(next: boolean): AmbientVoiceSnapshot {
      if (next === enabled) return this.snapshot();
      enabled = next;
      if (enabled) {
        startListening();
      } else {
        restartTimer?.cancel();
        restartTimer = null;
        const current = sessionId;
        sessionId = null;
        status = "off";
        // Turning it off forgets what was heard.
        buffer = new AmbientTranscriptBuffer();
        if (current) {
          try {
            deps.cancelSession(current);
          } catch {
            // Already gone.
          }
        }
      }
      return this.snapshot();
    },
    transcript() {
      return buffer.transcript();
    },
    /** Open pages listen here; each batch should run on exactly one of them. */
    subscribePageActions(fn: (batch: AmbientPageActions) => void): () => void {
      pageSubscribers.add(fn);
      return () => pageSubscribers.delete(fn);
    },
    /** First claim wins, so several open pages don't all navigate. */
    claimPageActions(id: string): boolean {
      const expires = unclaimed.get(id);
      unclaimed.delete(id);
      return expires !== undefined && expires > now();
    },
    snapshot(): AmbientVoiceSnapshot {
      return {
        enabled,
        status,
        buffer: buffer.snapshot(),
        lastSubmit,
        lastError,
      };
    },
  };
}

export type AmbientVoiceController = ReturnType<typeof createAmbientVoiceController>;
