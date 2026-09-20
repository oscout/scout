/**
 * One turn of a live voice call, as lanes on a shared clock.
 *
 * Seconds are relative to the turn origin (first event of that turn).
 * Wall-clock `at` values on events are milliseconds.
 */

export type VoiceLane = "you" | "live" | "host" | "scoutbot" | "scout" | "voice";
export type VoiceTone = "you" | "live" | "host" | "snap" | "model" | "scout" | "prep" | "speak" | "quiet";

export type VoiceSpan = {
  id: string;
  lane: VoiceLane;
  tone: VoiceTone;
  start: number;
  end: number | null;
  label?: string;
  quote?: boolean;
};

export type VoiceTick = {
  id: string;
  lane: "scout";
  at: number;
  label: string;
};

export type VoiceTurn = {
  id: string;
  origin: number;
  quote: string;
  spans: VoiceSpan[];
  ticks: VoiceTick[];
};

export type VoiceLedger = {
  turns: VoiceTurn[];
};

export type VoiceLedgerEvent =
  | { t: "reset" }
  | { t: "speech"; speaker: "you" | "live"; at: number; end: number; text?: string }
  | { t: "you-open"; at: number }
  | { t: "you-close"; at: number; text?: string }
  | { t: "host-open"; at: number; label?: string }
  | { t: "host-close"; at: number }
  | { t: "bot-open"; at: number; label?: string }
  | { t: "bot-close"; at: number }
  | { t: "prep-open"; at: number; label?: string }
  | { t: "prep-close"; at: number }
  | { t: "speak-open"; at: number; text?: string }
  | { t: "speak-close"; at: number }
  | { t: "action"; at: number; label: string }
  | { t: "close"; at: number };

export const EMPTY_LEDGER: VoiceLedger = { turns: [] };

const NEW_TURN_GAP_S = 0.8;

function rel(origin: number, at: number): number {
  return Math.max(0, (at - origin) / 1000);
}

function current(ledger: VoiceLedger): VoiceTurn | undefined {
  return ledger.turns.at(-1);
}

function replaceCurrent(ledger: VoiceLedger, turn: VoiceTurn): VoiceLedger {
  return { turns: [...ledger.turns.slice(0, -1), turn] };
}

function lastSpan(turn: VoiceTurn, lane: VoiceLane): VoiceSpan | undefined {
  return [...turn.spans].reverse().find((s) => s.lane === lane);
}

function closeOpen(turn: VoiceTurn, lane: VoiceLane, at: number): VoiceTurn {
  const t = rel(turn.origin, at);
  return {
    ...turn,
    spans: turn.spans.map((s) => (s.lane === lane && s.end === null ? { ...s, end: Math.max(t, s.start) } : s)),
  };
}

function openSpan(turn: VoiceTurn, span: Omit<VoiceSpan, "id">, id: string): VoiceTurn {
  return { ...turn, spans: [...turn.spans, { ...span, id }] };
}

function shouldStartTurn(turn: VoiceTurn | undefined, at: number, kind: "you" | "speech-you"): boolean {
  if (!turn) return true;
  const you = lastSpan(turn, "you");
  if (!you) return false;
  if (you.end === null && kind === "you") return false;
  if (you.end === null) return false;
  const t = rel(turn.origin, at);
  return t - you.end >= NEW_TURN_GAP_S;
}

function ensureTurn(ledger: VoiceLedger, at: number, quote = ""): VoiceLedger {
  const cur = current(ledger);
  if (cur && !shouldStartTurn(cur, at, "you")) return ledger;
  const turn: VoiceTurn = { id: `turn-${at}`, origin: at, quote, spans: [], ticks: [] };
  return { turns: [...ledger.turns, turn] };
}

const FILLER_QUOTE = /^(um+|uh+|ah+|er+|hmm+|mm+|mhm|yeah|yep|ok|okay|like|so|and|well|\d+)$/i;

export function formatVoiceQuote(text: string | undefined): string {
  if (!text) return "";
  let value = text.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
  value = value.replace(/^[,;:.\-–—]+/, "");
  value = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  value = value.replace(/([.!?])([A-Za-z])/g, "$1 $2");
  value = value.replace(/\b(\w+)(?:\s*,\s*\1)+\b/gi, "$1");
  return value.replace(/\s+/g, " ").trim();
}

function joinQuote(prev: string, next: string): string {
  const left = formatVoiceQuote(prev);
  const right = formatVoiceQuote(next);
  if (!right) return left;
  if (!left) return right;
  if (left === right) return left;
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  if (lowerRight.startsWith(lowerLeft)) return right;
  if (lowerLeft.startsWith(lowerRight)) return left;
  if (lowerLeft.includes(lowerRight) && right.length < left.length) return left;
  return `${left} ${right}`;
}

function setQuote(turn: VoiceTurn, text: string | undefined): VoiceTurn {
  const next = formatVoiceQuote(text);
  if (!next) return turn;
  const quote = joinQuote(turn.quote, next).slice(0, 240);
  return quote === turn.quote ? turn : { ...turn, quote };
}

export function isQuietVoiceTurn(turn: VoiceTurn, now?: number): boolean {
  const hasWork = turn.ticks.length > 0
    || turn.spans.some((span) => span.lane === "live" || span.lane === "voice" || span.lane === "scoutbot" || span.lane === "scout");
  if (hasWork) return false;
  const quote = formatVoiceQuote(turn.quote);
  const total = turnTotal(turn, now);
  if (!quote) return total < 0.8;
  const compact = quote.replace(/[.,!?'’]/g, "").trim();
  if (FILLER_QUOTE.test(compact) && total < 1.5) return true;
  return quote.length < 3 && total < 0.6;
}

export function reduceLedger(ledger: VoiceLedger, event: VoiceLedgerEvent): VoiceLedger {
  if (event.t === "reset") return EMPTY_LEDGER;

  if (event.t === "speech") {
    const speakerYou = event.speaker === "you";
    let next = speakerYou ? ensureTurn(ledger, event.at, event.text) : ledger;
    if (!current(next)) next = ensureTurn(next, event.at, event.text);
    const turn = current(next)!;
    const start = rel(turn.origin, event.at);
    const end = rel(turn.origin, event.end);
    const lane: VoiceLane = speakerYou ? "you" : "live";
    const tone: VoiceTone = speakerYou ? "you" : "live";
    const last = lastSpan(turn, lane);
    let spans = turn.spans;
    if (last && last.end !== null && start - last.end < 0.35) {
      spans = turn.spans.map((s) => (s.id === last.id ? { ...s, end, label: event.text?.trim() || s.label } : s));
    } else if (last && last.end === null) {
      spans = turn.spans.map((s) => (s.id === last.id ? { ...s, end, label: event.text?.trim() || s.label } : s));
    } else {
      spans = [...turn.spans, {
        id: `${lane}-${event.at}`,
        lane,
        tone,
        start,
        end,
        label: event.text?.trim() || undefined,
        quote: Boolean(event.text?.trim()) && speakerYou,
      }];
    }
    const quoted = speakerYou ? setQuote({ ...turn, spans }, event.text) : { ...turn, spans };
    return replaceCurrent(next, quoted);
  }

  if (event.t === "you-open") {
    const next = ensureTurn(ledger, event.at);
    const turn = current(next)!;
    if (lastSpan(turn, "you")?.end === null) return next;
    return replaceCurrent(next, openSpan(turn, { lane: "you", tone: "you", start: rel(turn.origin, event.at), end: null, quote: true }, `you-${event.at}`));
  }

  if (event.t === "you-close") {
    const turn = current(ledger);
    if (!turn) return ledger;
    return replaceCurrent(ledger, setQuote(closeOpen(turn, "you", event.at), event.text));
  }

  if (event.t === "host-open") {
    const turn = current(ledger) ?? ensureTurn(ledger, event.at).turns.at(-1)!;
    const next = current(ledger) ? ledger : { turns: [...ledger.turns, turn] };
    const cur = current(next)!;
    return replaceCurrent(next, openSpan(closeOpen(cur, "you", event.at), {
      lane: "host",
      tone: "host",
      start: rel(cur.origin, event.at),
      end: null,
      label: event.label ?? "transcribe",
    }, `host-${event.at}`));
  }

  if (event.t === "host-close") {
    const turn = current(ledger);
    if (!turn) return ledger;
    return replaceCurrent(ledger, closeOpen(turn, "host", event.at));
  }

  if (event.t === "bot-open") {
    let next = ledger;
    if (!current(next)) next = ensureTurn(next, event.at);
    const turn = closeOpen(current(next)!, "host", event.at);
    if (lastSpan(turn, "scoutbot")?.end === null) return replaceCurrent(next, turn);
    return replaceCurrent(next, openSpan(turn, {
      lane: "scoutbot",
      tone: "model",
      start: rel(turn.origin, event.at),
      end: null,
      label: event.label ?? "Scout lookup",
    }, `bot-${event.at}`));
  }

  if (event.t === "bot-close") {
    const turn = current(ledger);
    if (!turn) return ledger;
    return replaceCurrent(ledger, closeOpen(turn, "scoutbot", event.at));
  }

  if (event.t === "prep-open") {
    const turn = current(ledger);
    if (!turn) return ledger;
    return replaceCurrent(ledger, openSpan(closeOpen(turn, "scoutbot", event.at), {
      lane: "voice",
      tone: "prep",
      start: rel(turn.origin, event.at),
      end: null,
      label: event.label ?? "prepare",
    }, `prep-${event.at}`));
  }

  if (event.t === "prep-close") {
    const turn = current(ledger);
    if (!turn) return ledger;
    return replaceCurrent(ledger, closeOpen(turn, "voice", event.at));
  }

  if (event.t === "speak-open") {
    const turn = current(ledger);
    if (!turn) return ledger;
    const closed = closeOpen(closeOpen(turn, "voice", event.at), "scoutbot", event.at);
    return replaceCurrent(ledger, openSpan(closed, {
      lane: "voice",
      tone: "speak",
      start: rel(closed.origin, event.at),
      end: null,
      label: event.text?.trim() || "spoken reply",
      quote: Boolean(event.text?.trim()),
    }, `speak-${event.at}`));
  }

  if (event.t === "speak-close") {
    const turn = current(ledger);
    if (!turn) return ledger;
    return replaceCurrent(ledger, closeOpen(turn, "voice", event.at));
  }

  if (event.t === "action") {
    const turn = current(ledger);
    if (!turn) return ledger;
    const at = rel(turn.origin, event.at);
    return replaceCurrent(ledger, {
      ...turn,
      ticks: [...turn.ticks, { id: `act-${event.at}`, lane: "scout", at, label: event.label }],
    });
  }

  if (event.t === "close") {
    const turn = current(ledger);
    if (!turn) return ledger;
    const t = rel(turn.origin, event.at);
    return replaceCurrent(ledger, {
      ...turn,
      spans: turn.spans.map((s) => (s.end === null ? { ...s, end: Math.max(t, s.start) } : s)),
    });
  }

  return ledger;
}

export function turnWindow(turn: VoiceTurn, now?: number): number {
  return Math.max(8, Math.ceil(turnTotal(turn, now) + 0.4));
}

export function turnTotal(turn: VoiceTurn, now?: number): number {
  const ends = turn.spans.map((s) => s.end ?? now ?? s.start);
  const ticks = turn.ticks.map((t) => t.at);
  return Math.max(0.1, ...ends, ...ticks, now ?? 0);
}

export function turnStrip(turn: VoiceTurn, now?: number): { from: number; to: number; tone: VoiceTone }[] {
  const end = turnTotal(turn, now);
  const segs = [...turn.spans]
    .map((s) => ({ from: s.start, to: s.end ?? end, tone: s.tone }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  const strip: { from: number; to: number; tone: VoiceTone }[] = [];
  let cursor = 0;
  for (const seg of segs) {
    if (seg.from > cursor + 0.05) strip.push({ from: cursor, to: seg.from, tone: "quiet" });
    const from = Math.max(seg.from, cursor);
    if (seg.to > from) strip.push({ from, to: seg.to, tone: seg.tone });
    cursor = Math.max(cursor, seg.to);
  }
  if (end > cursor + 0.05) strip.push({ from: cursor, to: end, tone: "quiet" });
  return strip;
}

export function turnFloor(turn: VoiceTurn, now: number): { who: string; since: number; beneath?: string } {
  const open = turn.spans.filter((s) => s.start <= now && (s.end === null || s.end > now));
  const you = open.find((s) => s.lane === "you");
  const voice = open.find((s) => s.lane === "live" || s.lane === "voice");
  const bot = open.find((s) => s.lane === "scoutbot");
  const host = open.find((s) => s.lane === "host");
  if (you) return { who: "you", since: now - you.start, beneath: bot || host ? "working" : undefined };
  if (voice) return { who: "Scout", since: now - voice.start, beneath: voice.tone === "prep" ? (voice.label ?? "generating speech") : bot ? "lookup still running" : undefined };
  if (bot) return { who: "Scoutbot", since: now - bot.start, beneath: bot.label ?? "working" };
  if (host) return { who: "Scoutbot", since: now - host.start, beneath: "transcribing" };
  const last = Math.max(0, ...turn.spans.map((s) => s.end ?? 0), ...turn.ticks.map((t) => t.at));
  return { who: "open", since: Math.max(0, now - last) };
}

export function turnSettle(turn: VoiceTurn, now?: number): string {
  const total = turnTotal(turn, now);
  const dur = (lane: VoiceLane, tones?: VoiceTone[]) =>
    turn.spans
      .filter((s) => s.lane === lane && (!tones || (s.tone && tones.includes(s.tone))))
      .reduce((n, s) => n + Math.max(0, (s.end ?? now ?? s.start) - s.start), 0);
  const you = dur("you");
  const spoken = dur("live") + dur("voice", ["speak"]);
  const speechGen = dur("voice", ["prep"]);
  const host = dur("host");
  const bot = dur("scoutbot");
  const actions = turn.ticks.map((t) => t.label).join(", ");
  const parts = [`${total.toFixed(1)}s`];
  if (you > 0.05) parts.push(`you ${you.toFixed(1)}s`);
  if (host > 0.05) parts.push(`transcribe ${host.toFixed(1)}s`);
  if (bot > 0.05) parts.push(`Scoutbot ${bot.toFixed(1)}s`);
  if (actions) parts.push(actions);
  if (speechGen > 0.05) parts.push(`tts ${speechGen.toFixed(1)}s`);
  if (spoken > 0.05) parts.push(`spoken ${spoken.toFixed(1)}s`);
  return parts.join(" · ");
}

export function actionTickLabel(action: { type: string; targetLabel?: string; path?: string; route?: { view?: string } }): string {
  if (action.type === "navigate") return `navigate /${action.route?.view ?? "route"}`;
  if (action.type === "ask-agent") return `ask ${action.targetLabel ?? "agent"}`;
  if (action.type === "view-file") {
    const path = action.path ?? "file";
    return `view ${path.slice(path.lastIndexOf("/") + 1)}`;
  }
  if (action.type === "refresh") return "refresh";
  return action.type.replace(/-/g, " ");
}
