/**
 * Comms · what is open beside the stage, and what a selection is made of.
 *
 * Three different things can be "open" on a Comms page, and this file keeps
 * them apart, because a deck that could not tell them apart filled up with
 * everything ever glanced at:
 *
 *  - The STAGE is the one conversation the route names. Every click that names
 *    a conversation — a rail row, a strip card, a column's ↗ — lands there and
 *    replaces what was showing. It never adds a column.
 *
 *  - BESIDE is the list of conversations kept open in columns next to the
 *    stage, on every Comms page, until closed. Nothing arrives there by
 *    browsing: only the beside button, the context menu or a double click puts
 *    a conversation there. The list rides the URL as `?open=` so a link
 *    reproduces it, and so it survives navigating between conversations.
 *
 *  - A SELECTION is the one thing clicked in a drawing (Flow, Map, Canvas): a
 *    task, an exchange, a participant or a message. Its detail shows in one
 *    panel docked to the drawing; clicking another replaces it. A selection is
 *    local to the drawing and lives in no URL.
 *
 * Everything here is pure. CommsDeck.tsx draws the beside columns and
 * CommsSelection.tsx draws the selection.
 */

import type { FlowActor, FlowPass } from "../../lib/comms-flow.ts";
import type { FlowTask } from "./comms-flow-map.ts";

export type DeckCard =
  | { kind: "conversation"; conversationId: string }
  | { kind: "task"; askId: string }
  | { kind: "pair"; from: string; to: string }
  | { kind: "actor"; actorId: string }
  | { kind: "message"; passId: string };

/**
 * The route token for a card, which is also its React key and its identity.
 * A card is a *reference*: everything shown is derived from the window, so a
 * list restored from a URL is the same list.
 *
 * `~` separates a pair because it is unreserved in a URL and appears in no id
 * we mint; `,` separates cards for the same reason.
 */
export function deckToken(card: DeckCard): string {
  switch (card.kind) {
    case "conversation":
      return `c:${card.conversationId}`;
    case "task":
      return `t:${card.askId}`;
    case "pair":
      return `p:${card.from}~${card.to}`;
    case "actor":
      return `a:${card.actorId}`;
    case "message":
      return `m:${card.passId}`;
  }
}

export function deckCard(token: string): DeckCard | null {
  const body = token.slice(2);
  if (!body) return null;
  switch (token.slice(0, 2)) {
    case "c:":
      return { kind: "conversation", conversationId: body };
    case "t:":
      return { kind: "task", askId: body };
    case "p:": {
      const cut = body.indexOf("~");
      if (cut <= 0 || cut === body.length - 1) return null;
      return { kind: "pair", from: body.slice(0, cut), to: body.slice(cut + 1) };
    }
    case "a:":
      return { kind: "actor", actorId: body };
    case "m:":
      return { kind: "message", passId: body };
    default:
      return null;
  }
}

/* ---- Beside ---- */

/** The search key the beside list rides in. Sticky on Comms paths (scope/paths.ts). */
export const BESIDE_PARAM = "open";

/**
 * The conversations kept beside the stage, from a `?open=` value, in the order
 * they were kept.
 *
 * Only a conversation can be kept: it is an addressable thing that outlives
 * the drawing it was found in, where a task, an exchange, a participant or a
 * message is a slice of one window and means nothing on the next page. A
 * link from before the stage existed may carry those tokens, and may mark one
 * column with a leading `~` as the one being browsed; both are read past.
 */
export function besideFromRoute(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids: string[] = [];
  for (const raw of value.split(",")) {
    const card = deckCard(raw.trim().replace(/^~/, ""));
    if (!card || card.kind !== "conversation") continue;
    // A duplicate in the URL is one column, not two.
    if (!ids.includes(card.conversationId)) ids.push(card.conversationId);
  }
  return ids;
}

export function besideRoute(ids: readonly string[]): string {
  return ids.map((id) => deckToken({ kind: "conversation", conversationId: id })).join(",");
}

/** Returns the same list when nothing changes, so a repeat press does not churn state. */
export function besideAdd(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

export function besideRemove(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((held) => held !== id) : ids;
}

export function besideToggle(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? besideRemove(ids, id) : besideAdd(ids, id);
}

/* ---- Selection ---- */

/** What a card is made of: passes, in the order they happened. */
export function deckPasses(
  card: DeckCard,
  passes: readonly FlowPass[],
  tasks: readonly FlowTask[],
): FlowPass[] {
  switch (card.kind) {
    case "task": {
      const task = tasks.find((entry) => entry.id === card.askId);
      return task ? [...task.passes] : [];
    }
    case "pair":
      return passes.filter(
        (pass) => pass.from.id === card.from && pass.audience.some((actor) => actor.id === card.to),
      );
    case "actor":
      return passes.filter(
        (pass) =>
          pass.from.id === card.actorId || pass.audience.some((actor) => actor.id === card.actorId),
      );
    case "message": {
      const pass = passes.find((entry) => entry.id === card.passId);
      return pass ? [pass] : [];
    }
    case "conversation":
      // A conversation is served live by its own screen, not from this window.
      return [];
  }
}

/** Which participants a card is about, so the drawing can step everything else back. */
export function deckNodes(card: DeckCard, tasks: readonly FlowTask[]): string[] {
  switch (card.kind) {
    case "task": {
      const task = tasks.find((entry) => entry.id === card.askId);
      return task ? [task.waiter.id, task.worker.id] : [];
    }
    case "pair":
      return [card.from, card.to];
    case "actor":
      return [card.actorId];
    case "message":
    case "conversation":
      return [];
  }
}

/**
 * What the drawing should light for a selection. Null is "nothing asked" —
 * the drawing shows everything — not "dim everything".
 */
export function deckFocus(
  selected: DeckCard | null,
  tasks: readonly FlowTask[],
): Set<string> | null {
  if (!selected) return null;
  const ids = new Set(deckNodes(selected, tasks));
  return ids.size > 0 ? ids : null;
}

/**
 * The conversations a selection's passes ran in, most recent first. This is
 * how a drawing leads back to something you can read and answer: a task, an
 * exchange or a participant is not a page, but the conversation it happened
 * in is.
 */
export function deckConversations(
  card: DeckCard,
  passes: readonly FlowPass[],
  tasks: readonly FlowTask[],
): string[] {
  const latest = new Map<string, number>();
  for (const pass of deckPasses(card, passes, tasks)) {
    const id = pass.message.conversationId;
    if (!id) continue;
    latest.set(id, Math.max(latest.get(id) ?? 0, pass.at));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export const DECK_KICKER: Record<DeckCard["kind"], string> = {
  conversation: "Conversation",
  task: "Task",
  pair: "Exchange",
  actor: "Participant",
  message: "Message",
};

/**
 * A card's title, resolved from the window rather than stored on the card.
 * `name` answers "what is this actor called" — the selection has no roster of
 * its own.
 */
export function deckTitle(
  card: DeckCard,
  tasks: readonly FlowTask[],
  passes: readonly FlowPass[],
  name: (actorId: string) => string,
): string {
  switch (card.kind) {
    case "task":
      return tasks.find((entry) => entry.id === card.askId)?.title ?? "This task is not in this window";
    case "pair":
      return `${name(card.from)} → ${name(card.to)}`;
    case "actor":
      return name(card.actorId);
    case "message": {
      const pass = passes.find((entry) => entry.id === card.passId);
      if (!pass) return "This message is not in this window";
      const line = pass.message.body.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
      return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line || `${pass.from.short}'s message`;
    }
    case "conversation":
      return card.conversationId;
  }
}

/** The roster a selection needs, gathered from the window it is drawn over. */
export function deckNames(passes: readonly FlowPass[]): Map<string, string> {
  const names = new Map<string, string>();
  const put = (actor: FlowActor) => {
    if (!names.has(actor.id)) names.set(actor.id, actor.short);
  };
  for (const pass of passes) {
    put(pass.from);
    for (const actor of pass.audience) put(actor);
  }
  return names;
}
