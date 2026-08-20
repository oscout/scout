/** Reading model for the bundled chat surface.
 *
 * Two decisions live here rather than in the component, because both are
 * product rules that need to hold identically across Messages/WhatsApp and
 * Normie/Techie, and both are worth testing without a DOM:
 *
 * 1. Density — one global reading scale. It moves measure and body type
 *    together, because "how much conversation fits on screen" is a single
 *    perceptual axis, not two knobs.
 * 2. Sender attribution — whether a name above a bubble is carrying
 *    information, or repeating the header.
 */

export type ChatDensity = "comfortable" | "standard" | "compact";
export type ChatMode = "normie" | "techie";

export const CHAT_DENSITIES: readonly ChatDensity[] = ["comfortable", "standard", "compact"];

/** The refined baseline: bubbles a little wider and body type a little more
 * compact than the first pass, while staying above the 14px readability floor
 * in every style. */
export const DEFAULT_CHAT_DENSITY: ChatDensity = "standard";

export function resolveDensity(value: unknown): ChatDensity {
  return CHAT_DENSITIES.includes(value as ChatDensity) ? (value as ChatDensity) : DEFAULT_CHAT_DENSITY;
}

/** Palette slots for multi-sender attribution. Deliberately four non-red hues:
 * red stays reserved for failure, destruction, and blocked states. */
export const SENDER_HUE_COUNT = 4;

export type AttributedMessage = {
  actorId: string;
  isOperator: boolean;
};

export type SenderAttribution = {
  /** Distinct non-operator actors in the loaded window, in first-seen order. */
  readonly incomingActorIds: readonly string[];
  /** True once a second voice has spoken — the point at which a name above a
   * bubble stops repeating the header and starts disambiguating. */
  readonly multiSender: boolean;
  /** Stable palette slot for an actor, assigned by first appearance. */
  hueIndexOf(actorId: string): number;
};

export function senderAttribution(messages: readonly AttributedMessage[]): SenderAttribution {
  const order = new Map<string, number>();
  for (const message of messages) {
    if (message.isOperator) continue;
    if (!order.has(message.actorId)) order.set(message.actorId, order.size);
  }
  return {
    incomingActorIds: [...order.keys()],
    multiSender: order.size > 1,
    hueIndexOf: (actorId: string) => (order.get(actorId) ?? 0) % SENDER_HUE_COUNT,
  };
}

/** Show a sender name only where conversation topology actually requires it.
 *
 * A one-to-one Normie chat already names its counterpart in the header, so
 * repeating it on every incoming bubble is noise. Techie keeps the label
 * because knowing which machine voice produced a turn is the point of that
 * mode — it is attribution, not an error, and is coloured accordingly. */
export function showsSenderLabel(options: {
  mode: ChatMode;
  isOperator: boolean;
  grouped: boolean;
  multiSender: boolean;
}): boolean {
  if (options.isOperator) return false;
  if (options.grouped) return false;
  return options.mode === "techie" || options.multiSender;
}

/** A burst reads as one block only when it is genuinely one voice. Comparing
 * `isOperator` alone silently merged two different agents in a group thread. */
export function isGroupedWithPrevious(
  message: { actorId: string; isOperator: boolean; createdAt: number },
  previous: { actorId: string; isOperator: boolean; createdAt: number } | undefined,
  windowMs = 120_000,
): boolean {
  if (!previous) return false;
  if (previous.isOperator !== message.isOperator) return false;
  if (previous.actorId !== message.actorId) return false;
  return message.createdAt - previous.createdAt < windowMs;
}

/** Paired-host sync status.
 *
 * The surface used to assert "Messages travel through your paired Scout host."
 * regardless of whether anything was actually connected. This says only what
 * the host reports, names the machine when it is known, and never claims a
 * healthy link it does not have. */

export type HostState = "synced" | "connecting" | "degraded" | "offline" | "failed";

export type HostIdentity = { name?: string | null; state?: string | null };

/** Which colour family the status may use. `neutral` is the default; the two
 * reserved families are earned, not decorative. */
export type HostTone = "neutral" | "warning" | "error";

export type HostStatus = { text: string; tone: HostTone; state: HostState };

const HOST_STATES: readonly HostState[] = ["synced", "connecting", "degraded", "offline", "failed"];

const HOST_COPY: Record<HostState, { withName(name: string): string; withoutName: string; tone: HostTone }> = {
  synced:     { withName: (name) => `Synced with ${name}`,      withoutName: "Synced with host",   tone: "neutral" },
  connecting: { withName: (name) => `Connecting to ${name}…`,   withoutName: "Connecting…",        tone: "neutral" },
  // A link that exists but is not carrying traffic is worth attention.
  degraded:   { withName: (name) => `Reconnecting to ${name}`,  withoutName: "Reconnecting",       tone: "warning" },
  offline:    { withName: (name) => `Not connected to ${name}`, withoutName: "Not connected",      tone: "warning" },
  failed:     { withName: (name) => `Can’t reach ${name}`,      withoutName: "Host unreachable",   tone: "error" },
};

/** Returns null when the host reports nothing usable — the surface then shows
 * no status at all, which is honest, rather than a reassuring default. */
export function hostStatus(identity: HostIdentity | null | undefined): HostStatus | null {
  const state = identity?.state;
  if (!HOST_STATES.includes(state as HostState)) return null;
  const resolved = state as HostState;
  const copy = HOST_COPY[resolved];
  const name = typeof identity?.name === "string" ? identity.name.trim() : "";
  return {
    text: name ? copy.withName(name) : copy.withoutName,
    tone: copy.tone,
    state: resolved,
  };
}

/** Compact identity for the person or agent behind a message.
 *
 * Only facts the payload actually carries. The conversation's session
 * describes ONE agent, so its runtime/model/project may be attached to that
 * agent and to nobody else — in a group thread the other voices get their
 * name and kind and nothing invented to fill the card out. */

export type IdentitySession = {
  name?: string | null;
  adapterType?: string | null;
  status?: string | null;
  cwd?: string | null;
  model?: string | null;
};

export type IdentityFact = { label: string; value: string };

export type Identity = {
  name: string;
  kind: "person" | "agent" | "system" | "unknown";
  facts: IdentityFact[];
  /** Shown only when it would change what you do next. */
  status: string | null;
  /** True when this identity is the conversation's own agent, which is the
   * only case where a deeper conversation-scoped destination is truthful. */
  isConversationAgent: boolean;
};

function projectName(cwd: string | null | undefined) {
  const trimmed = typeof cwd === "string" ? cwd.trim().replace(/\/+$/, "") : "";
  if (!trimmed) return null;
  return trimmed.split("/").filter(Boolean).at(-1) ?? null;
}

function clean(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Status words arrive from the adapter in machine form. */
export function humaniseStatus(status: string | null | undefined) {
  const value = clean(status);
  if (!value) return null;
  const spaced = value.replaceAll("_", " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Statuses that change what the operator would do next. A healthy agent
 * reporting "ready" or "active" answers no question, so it is not shown; a
 * connecting, errored, or closed one is worth a line. */
const DECISION_STATUSES = new Set(["connecting", "error", "closed", "failed", "waiting", "blocked"]);

export function decisionStatus(status: string | null | undefined): string | null {
  const value = clean(status);
  if (!value) return null;
  return DECISION_STATUSES.has(value.toLowerCase()) ? humaniseStatus(value) : null;
}

export function identityFor(options: {
  actorId: string;
  name: string;
  kind: Identity["kind"];
  mode: ChatMode;
  /** The only incoming voice in the window, when there is exactly one. */
  soleIncomingActorId: string | null;
  session: IdentitySession | null | undefined;
  hostName: string | null | undefined;
}): Identity {
  const { actorId, name, kind, mode, soleIncomingActorId, session, hostName } = options;
  // Session facts describe the conversation's agent. Attaching them to another
  // speaker in a group thread would be a guess wearing a fact's clothes.
  const isConversationAgent = kind === "agent" && soleIncomingActorId !== null && soleIncomingActorId === actorId;
  const facts: IdentityFact[] = [];

  const host = clean(hostName);
  if (host) facts.push({ label: "Host", value: host });

  if (isConversationAgent) {
    const project = projectName(session?.cwd);
    if (project) facts.push({ label: "Project", value: project });
    // Model is an identity fact people actually use, not deep machinery, so
    // it appears in both modes.
    const model = clean(session?.model);
    if (model) facts.push({ label: "Model", value: model });
    // Runtime is the machinery; Techie asked to see it.
    if (mode === "techie") {
      const runtime = clean(session?.adapterType);
      if (runtime) facts.push({ label: "Runtime", value: runtime });
    }
  }

  // Deliberately no Branch/worktree: nothing in the session contract carries
  // one (id, name, adapterType, status, cwd, model, providerMeta), and a
  // directory name is not a branch. Omitted rather than inferred.
  return {
    name,
    kind,
    facts,
    status: isConversationAgent ? decisionStatus(session?.status) : null,
    isConversationAgent,
  };
}
