import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatApi, ChatPresencePeople } from "./chat-api.ts";

export function useChatPresence(api: ChatApi, channelId: string | null, actorId: string | undefined, space: string, enabled: boolean) {
  const [people, setPeople] = useState<ChatPresencePeople>([]);
  const [unavailable, setUnavailable] = useState(false);
  const edit = useRef<(threadId: string | null) => void>(() => {});
  useEffect(() => {
    setPeople([]); setUnavailable(false);
    if (!enabled || !api.presence || !channelId || !actorId) { edit.current = () => {}; return; }
    const clientId = crypto.randomUUID();
    let sequence = 0, editedAt = 0, lastSent = 0, nextAttemptAt = 0, failures = 0;
    let threadId: string | null = null;
    let alive = true, busy = false;
    let observed: Array<Omit<ChatPresencePeople[number], "typing"> & { expiresAt: number; typing: Array<{ threadId: string | null; expiresInMs: number; expiresAt: number }> }> = [];
    const display = () => {
      const now = Date.now();
      const next = observed.filter(person => person.expiresAt > now).map(person => ({ ...person, typing: person.typing.filter(typing => typing.expiresAt > now) }));
      // Fresh countdown values do not change the rendered hint. Avoid rerendering
      // the whole feed each second when the visible people/typing scopes agree.
      const visibleKey = (rows: ChatPresencePeople) => JSON.stringify(rows.map(person => [person.actorId, person.name, [...new Set(person.typing.map(typing => typing.threadId))].sort()]));
      setPeople(previous => visibleKey(previous) === visibleKey(next) ? previous : next);
    };
    const send = async () => {
      if (!alive || busy || Date.now() < nextAttemptAt) return;
      busy = true; lastSent = Date.now();
      const active = !document.hidden;
      try {
        const result = await api.presence!(channelId, { clientId, sequence: ++sequence, active, typing: active && Date.now() - editedAt < 5000, threadId }, space);
        if (!alive) return;
        const now = Date.now();
        observed = result.people.filter(person => person.actorId !== actorId).map(person => ({ ...person, expiresAt: now + person.expiresInMs,
          typing: person.typing.map(typing => ({ ...typing, expiresAt: now + typing.expiresInMs })) }));
        failures = 0; nextAttemptAt = 0;
        display(); setUnavailable(false);
      } catch { if (alive) { nextAttemptAt = Date.now() + Math.min(30000, 2000 * 2 ** Math.min(failures++, 4)); observed = []; setPeople([]); setUnavailable(true); } }
      finally { busy = false; }
    };
    edit.current = root => { editedAt = Date.now(); threadId = root; if (Date.now() - lastSent >= 1000) void send(); };
    const visibility = () => {
      if (document.hidden) {
        editedAt = 0;
        // A higher sequence makes a delayed visible beat unable to revive this tab.
        void api.presence!(channelId, { clientId, sequence: ++sequence, active: false, typing: false }, space).catch(() => {});
      } else void send();
    };
    void send();
    const heartbeat = setInterval(() => { if (!document.hidden) void send(); }, Math.max(2000, api.presenceIntervalMs ?? 2000));
    const expiry = setInterval(display, 1000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive = false; edit.current = () => {};
      clearInterval(heartbeat); clearInterval(expiry); document.removeEventListener("visibilitychange", visibility);
      void api.presence!(channelId, { clientId, sequence: ++sequence, active: false, typing: false }, space).catch(() => {});
    };
  }, [api, channelId, actorId, space, enabled]);
  const edited = useCallback((threadId: string | null = null) => edit.current(threadId), []);
  return { people, unavailable, edited, supported: Boolean(api.presence) };
}

/**
 * The one presence sentence worth printing: who is typing. "Here recently" is
 * shown on the header's faces instead, and an empty or unreachable room says
 * nothing at all — "No other recent viewers" was a caption for an absence.
 */
export function chatPresenceText({ people, supported }: ReturnType<typeof useChatPresence>) {
  if (!supported) return null;
  const typers = people.filter(person => person.typing.length);
  if (!typers.length) return null;
  const names = typers.slice(0, 3).map(person => person.name).join(", ") + (typers.length > 3 ? ` and ${typers.length - 3} more` : "");
  return `${names} ${typers.length === 1 ? "is" : "are"} typing${typers.every(person => person.typing.every(typing => typing.threadId != null)) ? " in a thread" : ""}`;
}
