/**
 * The pass model behind Comms · Flow.
 *
 * A thread shows one conversation from the inside. A *chain* crosses
 * conversations: the ask leaves one, the answer comes back through another, and
 * no current surface can show who waited on whom. This turns stored messages
 * into directed passes — a sender, an audience, and the metadata that made it a
 * route — which the Flow drawings then arrange.
 *
 * Direction is never inferred from prose. A body that names an agent is not a
 * route; only what the sender actually addressed is. When nothing was
 * addressed, the message went to the conversation, and that is drawn as its own
 * thing rather than guessed into a pair.
 */

const RESEND_WINDOW_MS = 5 * 60_000;
const ASK_PREFIX = /^\s*\[ask:([^\]\s]+)\]/;

export type FlowActorKind = "operator" | "agent" | "broker";

export type FlowActor = {
  /** The canonical id. One actor may answer to several (see `ids`). */
  id: string;
  /** Every actorId that resolves to this actor: the operator is both "operator" and their own name. */
  ids: string[];
  name: string;
  short: string;
  kind: FlowActorKind;
};

/** Which rule produced a pass's recipients. Kept on the pass so a drawing can show its own evidence. */
export type FlowRoute =
  | "relayTargetIds"
  | "returnAddress"
  | "targetSessionId"
  | "statusReplyAuthor"
  | "targetAgentId"
  | "scopedTargets"
  | "conversation";

/** The fields of a stored message this model reads. Structural, so server rows and client records both fit. */
export type FlowSourceMessage = {
  id: string;
  conversationId: string;
  actorId: string;
  actorName?: string | null;
  body: string;
  createdAt: number;
  class?: string | null;
  metadata?: Record<string, unknown> | null;
  replyToMessageId?: string | null;
};

export type FlowPass = {
  id: string;
  message: FlowSourceMessage;
  from: FlowActor;
  /** Explicitly addressed recipients. Empty for a message sent to the conversation. */
  to: FlowActor[];
  /** Who actually receives it: `to`, or for a conversation-wide message the other speakers in that conversation. */
  audience: FlowActor[];
  at: number;
  /** How many identical resends collapsed into this pass. */
  count: number;
  kind: "message" | "status" | "channel";
  route: FlowRoute;
  /** Addressed to the operator: the "in" direction. */
  inbound: boolean;
  /** Milliseconds of silence before this pass. */
  gap: number;
  index: number;
  askId: string | null;
  /** The message this one answers, named by the sender rather than inferred. */
  opensId: string | null;
  replyTo: string | null;
};

/** An ask and the answer it eventually got. */
export type FlowFlight = {
  askId: string;
  opener: FlowPass;
  answer: FlowPass;
  waiter: FlowActor;
  worker: FlowActor;
  /** When the broker gave up on the ask, if it said so before the answer arrived. */
  timedOutAt: number | null;
};

export type CommsFlow = {
  actors: FlowActor[];
  passes: FlowPass[];
  flights: FlowFlight[];
};

/* ── Identity ──────────────────────────────────────────────────────── */

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter((id): id is string => id !== null);
  const one = str(value);
  return one ? [one] : [];
}

/** Read a nested metadata object's string field, e.g. `returnAddress.actorId`. */
function nested(meta: Record<string, unknown>, key: string, field: string): string | null {
  const value = meta[key];
  if (!value || typeof value !== "object") return null;
  return str((value as Record<string, unknown>)[field]);
}

/**
 * Which session belongs to which agent, according to the messages themselves.
 *
 * An agent answers under its own id while everything addressed to it names the
 * session running it, so the same participant arrives under two names and gets
 * drawn as two rails talking to each other. A reply carries both — the agent in
 * `returnAddress.actorId`, the session in `responderSessionId` — so the link is
 * stated in the data rather than guessed from the shape of an id.
 */
export function flowAliases(messages: readonly FlowSourceMessage[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const message of messages) {
    const meta = message.metadata ?? {};
    const agent = nested(meta, "returnAddress", "actorId") ?? str(meta.generatedBy);
    const session = nested(meta, "returnAddress", "sessionId") ?? str(meta.responderSessionId);
    if (!agent || !session || agent === session) continue;
    aliases.set(session, agent);
  }
  return aliases;
}

/**
 * An agent's id may be scoped by project and host — `session-x.my-project.my-mac`
 * is the same session as `session-x`. The head is the agent; the rest says where
 * it was running. Collapsing on it is what the rest of the app already does
 * (`compactAgentId`), and not doing it draws one worker as two rails.
 */
export function flowCanonicalId(actorId: string, aliases?: ReadonlyMap<string, string>): string {
  const head = actorId.split(".")[0]?.trim() || actorId;
  const agent = aliases?.get(head) ?? aliases?.get(actorId);
  return agent ? (agent.split(".")[0]?.trim() || agent) : head;
}

/** A chunk of random id rather than a word: long enough to be generated, and carrying a digit. */
const isIdChunk = (word: string) => word.length >= 4 && /\d/.test(word);

/**
 * A label short enough to sit beside a rail. The full id stays on the pass, so
 * this only has to be recognisable, not unique — `openscout-agent-2` reads as
 * "Agent 2", `flat-claude-4fad8bb9-b4d3-…` as "Flat Claude".
 */
/** The project an actor belongs to, which is context rather than identity. */
const isProjectPrefix = (word: string) => /^(openscout|scout|blink|session|agent)$/i.test(word);

export function flowShortLabel(id: string, name?: string | null, keepProject = false): string {
  const given = str(name);
  const head = flowCanonicalId(id);
  // A stated name beats anything derivable from an id. A session is `session-
  // mszm5fro-elspoj` named `openscout-seneca-4`; labelling it "Mszm5fro" throws
  // away the only handle in the data a person could say out loud.
  const named = given !== null && given.toLowerCase() !== head.toLowerCase();
  let words = (named ? given! : head).split(/[-_\s]+/).filter(Boolean);
  if (!keepProject && words.length > 1 && isProjectPrefix(words[0]!)) words = words.slice(1);
  // A session id carries no name at all, so only its first chunk is a handle.
  // Everywhere else, trailing id chunks are noise — but never strip the last
  // word standing, or a pure-uuid actor loses its only label.
  if (!named) {
    if (/^session/i.test(head)) words.length = Math.min(words.length, 1);
    else while (words.length > 1 && isIdChunk(words[words.length - 1]!)) words.pop();
  }
  const label = words.map((w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  return label || given || id;
}

/**
 * The actors in a window.
 *
 * GOTCHA: the operator arrives under two actorIds — the canonical "operator"
 * and their own display name — and drawing them as two participants splits
 * every chain they are part of. They are merged here, so a pass addressed to
 * either lands on one lifeline.
 */
export function flowActors(
  messages: readonly FlowSourceMessage[],
  aliases: ReadonlyMap<string, string> = flowAliases(messages),
): FlowActor[] {
  const seen = new Map<string, { id: string; ids: string[]; name: string; kind: FlowActorKind }>();
  const note = (raw: string | null, name?: string | null) => {
    if (!raw) return;
    const id = flowCanonicalId(raw, aliases);
    const existing = seen.get(id);
    const kind: FlowActorKind = id === "system" ? "broker" : id === "operator" ? "operator" : "agent";
    if (!existing) seen.set(id, { id, ids: [raw], name: str(name) ?? id, kind });
    else {
      if (!existing.ids.includes(raw)) existing.ids.push(raw);
      if (existing.name === existing.id && str(name)) existing.name = str(name)!;
    }
  };

  for (const message of messages) {
    note(message.actorId, message.actorName);
    for (const id of addressedIds(message)) note(id);
  }

  const operatorName = [...seen.values()].find((a) => a.kind === "operator")?.name ?? null;
  const actors: FlowActor[] = [];
  const byId = new Map<string, FlowActor>();
  for (const entry of seen.values()) {
    // Any id that is just the operator's name is the operator under another label.
    const isOperator =
      entry.kind === "operator"
      || (operatorName !== null && entry.kind === "agent" && entry.id.toLowerCase() === operatorName.toLowerCase());
    const key = isOperator ? "operator" : entry.id;
    const existing = byId.get(key);
    if (existing) {
      for (const raw of entry.ids) if (!existing.ids.includes(raw)) existing.ids.push(raw);
      if (existing.name === existing.id && entry.name !== entry.id) existing.name = entry.name;
      continue;
    }
    const actor: FlowActor = {
      id: key,
      ids: [...entry.ids],
      name: isOperator ? operatorName ?? entry.name : entry.name,
      short: isOperator ? operatorName ?? entry.name : entry.id === "system" ? "Broker" : flowShortLabel(entry.id, entry.name),
      kind: isOperator ? "operator" : entry.kind,
    };
    byId.set(key, actor);
    actors.push(actor);
  }

  // Two sessions can be named for the same person on different projects
  // (openscout-pauli-3, blink-pauli-4). Drop the project only while every label
  // stays distinct — the same bargain a short git hash makes.
  const taken = new Map<string, number>();
  for (const actor of actors) taken.set(actor.short, (taken.get(actor.short) ?? 0) + 1);
  for (const actor of actors) {
    if (actor.kind !== "agent" || (taken.get(actor.short) ?? 0) < 2) continue;
    actor.short = flowShortLabel(actor.id, actor.name, true);
  }
  return actors;
}

/* ── Direction ─────────────────────────────────────────────────────── */

/** Every id this message addressed, ignoring which rule found them. */
function addressedIds(message: FlowSourceMessage): string[] {
  const meta = message.metadata ?? {};
  return [
    ...stringList(meta.relayTargetIds),
    ...stringList(meta.relayTarget),
    ...(nested(meta, "requestedReturnAddress", "actorId") ? [nested(meta, "requestedReturnAddress", "actorId")!] : []),
    ...stringList(meta.targetSessionId),
    ...stringList(meta.targetAgentId),
    ...(Array.isArray(meta.scopedTargets)
      ? meta.scopedTargets.map((t) => (t && typeof t === "object" ? str((t as { actorId?: unknown }).actorId) : null))
        .filter((id): id is string => id !== null)
      : []),
  ];
}

/**
 * Who a message was addressed to, first rule that fires.
 *
 * The order is the order of specificity, not of convenience: a relay names the
 * exact recipients the sender typed, while `targetAgentId` on a broker status
 * only names the agent the status is *about*. Reading them the other way round
 * makes the broker look like the sender of someone else's work.
 */
export function flowRecipients(
  message: FlowSourceMessage,
  bySender: ReadonlyMap<string, string>,
): { ids: string[]; route: FlowRoute } {
  const meta = message.metadata ?? {};

  const relay = [...stringList(meta.relayTargetIds), ...stringList(meta.relayTarget)];
  if (relay.length) return { ids: relay, route: "relayTargetIds" };

  // An answer says where it is going. This is the sender's own statement of
  // the recipient, so it outranks anything derived from who ran the work.
  const returning = nested(meta, "requestedReturnAddress", "actorId") ?? str(meta.requestedBy);
  if (returning) return { ids: [returning], route: "returnAddress" };

  // The session named here is the one that will run the message, which — once
  // sessions are resolved to their agents — is the agent it was sent to.
  const session = stringList(meta.targetSessionId);
  if (session.length) return { ids: session, route: "targetSessionId" };

  // A broker status answers the message that provoked it, so its recipient is
  // that message's author — which is who is actually waiting to hear it.
  if (message.class === "status" && message.replyToMessageId) {
    const author = bySender.get(message.replyToMessageId);
    if (author) return { ids: [author], route: "statusReplyAuthor" };
  }

  const agent = stringList(meta.targetAgentId);
  if (agent.length) return { ids: agent, route: "targetAgentId" };

  const scoped = Array.isArray(meta.scopedTargets)
    ? meta.scopedTargets
      .map((t) => (t && typeof t === "object" ? str((t as { actorId?: unknown }).actorId) : null))
      .filter((id): id is string => id !== null)
    : [];
  if (scoped.length) return { ids: scoped, route: "scopedTargets" };

  return { ids: [], route: "conversation" };
}

/* ── Passes ────────────────────────────────────────────────────────── */

export function flowPasses(
  messages: readonly FlowSourceMessage[],
  actors: readonly FlowActor[],
  aliases: ReadonlyMap<string, string> = flowAliases(messages),
): FlowPass[] {
  const byId = new Map<string, FlowActor>();
  for (const actor of actors) {
    byId.set(actor.id, actor);
    for (const id of actor.ids) byId.set(id, actor);
  }
  const actorFor = (raw: string): FlowActor | undefined => byId.get(raw) ?? byId.get(flowCanonicalId(raw, aliases));

  const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const senderOf = new Map(ordered.map((m) => [m.id, m.actorId]));
  const speakers = new Map<string, Set<string>>();
  for (const message of ordered) {
    const set = speakers.get(message.conversationId) ?? new Set<string>();
    set.add(message.actorId);
    speakers.set(message.conversationId, set);
  }

  const passes: FlowPass[] = [];
  for (const message of ordered) {
    const from = actorFor(message.actorId);
    if (!from) continue;
    const { ids, route } = flowRecipients(message, senderOf);
    const to = [...new Set(ids)]
      .map((id) => actorFor(id))
      .filter((a): a is FlowActor => a !== undefined && a.id !== from.id);

    // A retry is the same sender saying the same thing down the same route.
    // Anything else — a different body, a different recipient, a later window —
    // is a second pass and has to draw as one.
    const prev = passes[passes.length - 1];
    if (
      prev
      && prev.from.id === from.id
      && prev.message.body === message.body
      && prev.to.map((a) => a.id).join() === to.map((a) => a.id).join()
      && message.createdAt - prev.at < RESEND_WINDOW_MS
    ) {
      prev.count += 1;
      continue;
    }

    const kind: FlowPass["kind"] = message.class === "status" ? "status" : to.length === 0 ? "channel" : "message";
    // A message with no target went to the conversation, which means the people
    // who have spoken in it — not every actor on the diagram. Drawing it at
    // everyone invents pairs that never exchanged anything.
    const audience =
      kind === "channel"
        ? [...(speakers.get(message.conversationId) ?? [])]
          .map((id) => actorFor(id))
          .filter((a): a is FlowActor => a !== undefined && a.id !== from.id && a.kind !== "broker")
        : to;

    passes.push({
      id: message.id,
      message,
      from,
      to,
      audience: [...new Map(audience.map((a) => [a.id, a])).values()],
      at: message.createdAt,
      count: 1,
      kind,
      route,
      inbound: audience.some((a) => a.kind === "operator"),
      gap: prev ? message.createdAt - prev.at : 0,
      index: passes.length,
      // The broker's own id when there is one; the relay path only stamps the
      // flight into the body, so that stays the fallback.
      askId: str((message.metadata ?? {}).flightId) ?? ASK_PREFIX.exec(message.body)?.[1] ?? null,
      /** The message this answers, when the sender named it outright. */
      opensId: str((message.metadata ?? {}).sourceMessageId),
      replyTo: message.replyToMessageId ?? null,
    });
  }
  return passes;
}

/* ── Flights ───────────────────────────────────────────────────────── */

/**
 * Pair each ask with the answer that closed it.
 *
 * The answer carries the flight id; the ask does not, so the opener is the
 * message the answer replies to, or failing that the last thing addressed to
 * the answerer. A flight with no answer in the window is not a flight yet —
 * it is someone still waiting, and the drawing says so by leaving the rail open.
 */
export function flowFlights(passes: readonly FlowPass[]): FlowFlight[] {
  const flights: FlowFlight[] = [];
  const answered = new Set<string>();
  for (const answer of passes) {
    const askId = answer.askId;
    if (!askId || answered.has(askId)) continue;
    const opener =
      passes.find((p) => p.message.id === answer.opensId && p.index < answer.index)
      ?? passes.find((p) => p.message.id === answer.replyTo && p.index < answer.index)
      ?? [...passes].reverse().find(
        (p) => p.index < answer.index && p.kind === "message" && p.to.some((a) => a.id === answer.from.id),
      );
    if (!opener) continue;
    answered.add(askId);
    const timeout = passes.find(
      (p) => p.kind === "status" && p.replyTo === opener.message.id && p.index < answer.index,
    );
    // Who the work was actually given to. The answerer is normally the person
    // asked, and wins whenever they were; but the broker answers a timed-out
    // ask on the worker's behalf, and taking the answerer at face value there
    // credits the broker with work it only reported on.
    const asked = opener.audience.some((actor) => actor.id === answer.from.id);
    const addressed = opener.audience.find((actor) => actor.id !== opener.from.id);
    flights.push({
      askId,
      opener,
      answer,
      waiter: opener.from,
      worker: asked ? answer.from : addressed ?? answer.from,
      timedOutAt: timeout ? timeout.at : null,
    });
  }
  return flights;
}

export function buildCommsFlow(messages: readonly FlowSourceMessage[]): CommsFlow {
  const aliases = flowAliases(messages);
  const actors = flowActors(messages, aliases);
  const passes = flowPasses(messages, actors, aliases);
  return { actors, passes, flights: flowFlights(passes) };
}

/** A duration a person can read at a glance: 4s, 11m 51s, 2h 07m. */
export function flowDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${String(r).padStart(2, "0")}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
