import { useCallback, useEffect, useRef, useState } from "react";
import { MessageComposer } from "../../components/MessageComposer/index.ts";
import { startScoutSpeech } from "../../lib/scout-voice.ts";
import { ensureAgentChat } from "../../lib/agent-chat.ts";
import { isNativeSessionAgent, sendToFocusedAgentSession } from "../../lib/send-to-agent-session.ts";
import { useScout } from "../../scout/Provider.tsx";
import { spokenReplyAnnouncement } from "./spoken-reply.ts";
import { useAgentReplyAfter } from "./use-agent-reply.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { Route } from "../../lib/types.ts";

const TALK_BACK_KEY = "scout.world.talkBack";

/** Talk-back is a standing preference: turning it on once should outlive this popover. */
function loadTalkBack(): boolean {
  try { return window.localStorage.getItem(TALK_BACK_KEY) === "1"; } catch { return false; }
}

function saveTalkBack(on: boolean): void {
  try { window.localStorage.setItem(TALK_BACK_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}

type Sent = { conversationId: string | null; at: number };

export function WorldActorTalk({ lane, x, y, compose, voice = false, onTalk, onDictate, onProfile, onClose, onSent }: { lane: AgentLane; x: number; y: number; compose: boolean; voice?: boolean; onTalk: () => void; onDictate?: () => void; onProfile: () => void; onClose: () => void; onSent: () => void }) {
  const { route, navigate } = useScout();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  const [talkBack, setTalkBack] = useState(loadTalkBack);
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const voiceStarted = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const agentLabel = lane.agent.handle || lane.agent.name;

  useEffect(() => {
    if (compose) input.current?.focus(); else panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [compose]);
  useEffect(() => {
    if (compose && voice && !voiceStarted.current) {
      const mic = panel.current?.querySelector<HTMLButtonElement>(".s-dictation-mic");
      if (mic && !mic.disabled) { voiceStarted.current = true; mic.click(); }
    }
  }, [compose, voice]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !sending && !draft) onClose(); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [onClose, sending, draft]);

  // Only watch while talk-back is armed and something is actually outstanding.
  const replyWatch = useAgentReplyAfter(talkBack && sent ? sent.conversationId : null, sent?.at ?? null);
  const reply = replyWatch.status === "received" ? replyWatch.reply : null;
  useEffect(() => {
    if (!reply || !talkBack) return;
    const speech = startScoutSpeech(spokenReplyAnnouncement(agentLabel, reply.body));
    speech.promise.catch(() => setStatus("Reply arrived, but Scout could not speak it."));
    return () => speech.stop();
  }, [reply, talkBack, agentLabel]);

  async function send(body = draft) {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true); setStatus("");
    try {
      const destination = await sendToFocusedAgentSession(lane.agent, text);
      setDraft("");
      setSent({ conversationId: destination.conversationId, at: destination.sentAt });
      onSent();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not send message"); }
    finally { setSending(false); }
  }

  // Machine scope is a property of where you already are, not of the destination.
  const machineId = (route as { machineId?: string }).machineId;
  const openRoute = useCallback((extra: Partial<Extract<Route, { view: "agents-v2" }>>) => {
    navigate({ view: "agents-v2", agentId: lane.agent.id, ...(machineId ? { machineId } : {}), ...extra });
    onClose();
  }, [navigate, lane.agent.id, machineId, onClose]);

  const toggleTalkBack = () => setTalkBack((on) => { saveTalkBack(!on); return !on; });

  /**
   * Talk-back reads as a line of the menu, not a glyph in a corner.
   *
   * It was an unlabelled ◍ whose two states differed only in tint — nothing on
   * screen said what it did or whether it was doing it. Everything that decides
   * that here is now written out: what happens ("Read replies aloud"), whether
   * it is happening (the word, and a switch that sits on the side it is on),
   * and, once armed, what it is waiting for.
   */
  const talkBackRow = <button
    className={`world-actor-talk__talkback${talkBack ? " is-on" : ""}`}
    type="button"
    onClick={toggleTalkBack}
    aria-pressed={talkBack}
    title="Scout reads the first reply to your latest message aloud"
  >
    <span>Read replies aloud{talkBack && sent?.conversationId ? <small>{replyWatch.status === "received" ? "Reply received" : replyWatch.status === "timed-out" ? "Stopped waiting after five minutes. Open chat to check for replies." : "Listening for a reply…"}</small> : null}</span>
    <span className="world-actor-talk__state">
      <small>{talkBack ? "On" : "Off"}</small>
      <span className="world-actor-talk__switch" aria-hidden="true" />
    </span>
  </button>;

  /**
   * Where this agent is spoken to at length. A conversation exists once
   * something has been sent; before that we resolve (or open) the agent's chat
   * the same way the profile's own Message button does, so the menu item is
   * never a dead end. Native sessions have no conversation at all — they are
   * continued by session id — so those land on the session itself.
   */
  const openChat = async () => {
    if (opening) return;
    const known = sent?.conversationId;
    if (known) { openRoute({ conversationId: known, tab: "message" }); return; }
    if (isNativeSessionAgent(lane.agent)) {
      const sessionId = lane.agent.harnessSessionId?.trim();
      if (!sessionId) { setStatus("This native session has no session id to open."); return; }
      navigate({ view: "sessions", sessionId, ...(machineId ? { machineId } : {}) });
      onClose();
      return;
    }
    setOpening(true); setStatus("");
    try {
      openRoute({ conversationId: await ensureAgentChat(lane.agent), tab: "message" });
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open the chat."); }
    finally { setOpening(false); }
  };

  const receipt = sent ? <div className="world-actor-talk__receipt" role="status">
    <strong>Sent to {agentLabel}</strong>
    {sent.conversationId
      ? <div className="world-actor-talk__links">
        <button type="button" onClick={() => openRoute({ conversationId: sent.conversationId!, tab: "message" })}>Open chat →</button>
      </div>
      : <small>Native session — continued by session id, so there is no conversation to open.</small>}
  </div> : null;

  return <div ref={panel} className="world-actor-talk" style={{ left: Math.max(12, Math.min(x - 180, window.innerWidth - 372)), top: Math.max(12, Math.min(y, window.innerHeight - (compose ? 430 : 300))) }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !sending) onClose(); }} aria-label={`Talk to ${lane.agent.name}`}>
    {compose ? <>
      <header>
        <strong>Talk to {agentLabel}</strong>
        <span className="world-actor-talk__header-actions">
          <button type="button" onClick={onClose} disabled={sending} aria-label="Close composer">×</button>
        </span>
      </header>
      <MessageComposer
        density="panel"
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        // Voice mode was opened with a chord that means "say it and send it" —
        // the transcript commits instead of waiting to be read and pressed.
        onDictationCommit={voice ? (next) => void send(next) : undefined}
        sending={sending}
        textareaRef={input}
        rows={4}
        placeholder="Send a message…"
        aria-label="Message to this agent"
      />
      {talkBackRow}
      {receipt}
      <small role="status">{status || (voice ? "Dictation sends on stop · ⌥-click to type instead" : "Option-click to type · Shift-click to dictate and send")}</small>
    </> : <>
      <button type="button" onClick={onTalk}>Talk <small>⌥ / Alt + click</small></button>
      {onDictate ? <button type="button" onClick={onDictate}>Dictate &amp; send <small>⇧ / Shift + click</small></button> : null}
      {talkBackRow}
      <button type="button" onClick={() => void openChat()} disabled={opening}>Open chat <small>{opening ? "Opening…" : "Full conversation"}</small></button>
      <button type="button" onClick={() => openRoute({ tab: "profile" })}>Open agent profile</button>
      <button type="button" onClick={onProfile}>Focus on floor</button>
      <button type="button" onClick={onClose}>Dismiss</button>
      {status ? <small role="status">{status}</small> : null}
    </>}
  </div>;
}
