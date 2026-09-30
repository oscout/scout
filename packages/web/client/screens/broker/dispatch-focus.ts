import { brokerAttemptTone } from "../../lib/status-tone.ts";
import type { Agent, BrokerRouteAttempt, DispatchFilter, DispatchWindow } from "../../lib/types.ts";
import { brokerAttemptFailureTitle, brokerAttemptIsFailure, brokerAttemptTargetAgent } from "./broker-display.ts";

/**
 * Dispatch focus: one filter state produces one matching dispatch set, and the
 * graph, the ledger and the counts are all read from that set. Nothing here
 * changes a connection — focus is a view over routing records.
 *
 * Nodes are the parties on a dispatch edge: people, agents, sessions and
 * channels. Machines are deliberately NOT nodes. An agent runs on a machine,
 * but a dispatch is addressed to the agent, so the machine is shown as a fact
 * about a node rather than merged into its identity.
 */

export type DispatchNodeKind = "operator" | "agent" | "session" | "channel" | "unresolved";

export type DispatchNode = {
  /** Stable identity used for focus and URL state. */
  key: string;
  /** Concise display name. Full ids live in `address`. */
  label: string;
  kind: DispatchNodeKind;
  /** The full address as the broker recorded it, for copyable details. */
  address: string | null;
  agentId: string | null;
  /** The machine the agent is homed on, when known. Never a node itself. */
  machine: string | null;
};

export type DispatchDeliveryState = "attention" | "delivered" | "pending";

export type DispatchRowModel = {
  attempt: BrokerRouteAttempt;
  from: DispatchNode;
  to: DispatchNode;
  /** The request's first readable line, or null when the record kept no request text. */
  request: string | null;
  /** What the row leads with: the request, or the failure when no request was recorded. */
  title: string;
  delivery: DispatchDeliveryState;
};

export type { DispatchWindow };

export const DISPATCH_WINDOWS: Array<{ value: DispatchWindow; label: string }> = [
  { value: "all", label: "All loaded" },
  { value: "1h", label: "Last hour" },
  { value: "today", label: "Today" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

export function parseDispatchWindow(value: string | null | undefined): DispatchWindow | undefined {
  return DISPATCH_WINDOWS.some((entry) => entry.value === value) ? value as DispatchWindow : undefined;
}

export type DispatchScope = {
  /** Focused node keys. OR within the set. */
  nodes: string[];
  /** Only dispatches whose both ends are focused nodes. Needs two or more. */
  between: boolean;
  window: DispatchWindow;
  query: string;
  outcome: DispatchFilter;
};

// ── Identity ────────────────────────────────────────────────────────────────

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalized(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function agentByAddress(agents: Agent[], value: string | null): Agent | null {
  if (!value) return null;
  // "@name" and "session:<id>" are addressing forms of the same agent.
  const needle = normalized(value.trim().replace(/^@/, "").replace(/^session:(?=session-|flat-)/i, ""));
  return agents.find((agent) => [
    agent.id,
    agent.name,
    agent.handle,
    agent.selector,
    agent.defaultSelector,
    agent.conversationId,
    agent.harnessSessionId,
  ].some((candidate) => candidate && normalized(candidate) === needle)) ?? null;
}

const HARNESS_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  kimi: "Kimi",
  grok: "Grok",
  opencode: "OpenCode",
};

function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness.toLowerCase()] ?? harness.charAt(0).toUpperCase() + harness.slice(1);
}

/**
 * A short name for an address that resolved to no known agent. Session ids are
 * long and nearly identical at a glance; the row only needs enough to tell
 * them apart, and the full id stays one click away in the details.
 */
export function conciseAddressLabel(address: string): string {
  // "@muse" and "muse" are one node; label it the same way either way.
  const value = address.trim().replace(/^@(?=\S)/, "");
  // session:<harness>:<native id>  →  "Codex session 01a0e90f"
  const harnessSession = /^session:(?:session:)?([a-z]+):([0-9a-f]{6,})/i.exec(value);
  if (harnessSession) return `${harnessLabel(harnessSession[1]!)} session ${harnessSession[2]!.slice(0, 8)}`;
  // flat-claude-<uuid>
  const flat = /^flat-([a-z]+)-([0-9a-f]{8})/i.exec(value);
  if (flat) return `${harnessLabel(flat[1]!)} session ${flat[2]!}`;
  // session-<stamp>-<suffix> or session:session-…
  const scoutSession = /^(?:session:)?session-([a-z0-9]+)-[a-z0-9]+$/i.exec(value);
  if (scoutSession) return `Session ${scoutSession[1]!}`;
  // Humanized forms of the same ids ("Flat Claude 587e138a 9575 …",
  // "Session Mulxpra7 Pm02hw") arrive as display names.
  const flatName = /^flat ([a-z]+) ([0-9a-f]{8})\b/i.exec(value);
  if (flatName) return `${harnessLabel(flatName[1]!)} session ${flatName[2]!.toLowerCase()}`;
  const sessionName = /^session ([a-z0-9]{6,}) [a-z0-9]+$/i.exec(value);
  if (sessionName) return `Session ${sessionName[1]!.toLowerCase()}`;
  if (value.length > 28) return `${value.slice(0, 25)}…`;
  return value;
}

function looksLikeSession(address: string): boolean {
  return /^(session[:-]|flat-)/i.test(address.trim());
}

export function dispatchSenderNode(
  attempt: BrokerRouteAttempt,
  agents: Agent[],
  operatorName: string | null,
): DispatchNode {
  const metadata = attempt.metadata ?? {};
  const actorId = text(metadata.actorId) ?? text(metadata.requesterId);
  const actorClass = text(metadata.class)?.toLowerCase();
  const name = attempt.actorName?.trim() || actorId || "Unknown sender";
  const isOperator = actorId === "operator"
    || actorClass === "operator"
    || actorClass === "human"
    || Boolean(operatorName && normalized(name) === normalized(operatorName));
  if (isOperator) {
    return {
      key: "operator",
      label: operatorName?.trim() || name,
      kind: "operator",
      address: actorId ?? name,
      agentId: null,
      machine: null,
    };
  }
  const agent = agentByAddress(agents, actorId) ?? agentByAddress(agents, attempt.actorName);
  if (agent) return agentNode(agent, actorId ?? attempt.actorName);
  const address = actorId ?? name;
  return {
    key: `addr:${normalized(address)}`,
    label: conciseAddressLabel(name),
    kind: looksLikeSession(address) ? "session" : "unresolved",
    address,
    agentId: null,
    machine: null,
  };
}

function agentNode(agent: Agent, address: string | null): DispatchNode {
  return {
    key: `agent:${agent.id}`,
    label: conciseAddressLabel(agent.name || agent.id),
    kind: "agent",
    address: address ?? agent.id,
    agentId: agent.id,
    machine: agent.authorityNodeName ?? agent.homeNodeName ?? null,
  };
}

export function dispatchDestinationNode(
  attempt: BrokerRouteAttempt,
  agents: Agent[],
  operatorName: string | null,
): DispatchNode {
  const target = attempt.target?.trim() || null;
  if (target && (normalized(target) === "operator" || (operatorName && normalized(target) === normalized(operatorName)))) {
    return {
      key: "operator",
      label: operatorName?.trim() || "Operator",
      kind: "operator",
      address: target,
      agentId: null,
      machine: null,
    };
  }
  if (attempt.route === "channel" || attempt.route === "broadcast") {
    const label = target ? (target.startsWith("#") ? target : `#${target}`) : attempt.route === "broadcast" ? "Broadcast" : "Channel";
    return {
      key: `channel:${normalized(target ?? attempt.route)}`,
      label,
      kind: "channel",
      address: target,
      agentId: null,
      machine: null,
    };
  }
  const agent = brokerAttemptTargetAgent(attempt, agents) ?? agentByAddress(agents, target);
  if (agent) return agentNode(agent, target);
  const metadata = attempt.metadata ?? {};
  const raw = record(metadata.raw);
  const displayName = text(metadata.targetDisplayName) ?? text(raw?.targetDisplayName);
  const address = target ?? "No target";
  return {
    key: `addr:${normalized(address)}`,
    label: conciseAddressLabel(displayName ?? address),
    kind: target && looksLikeSession(target) ? "session" : "unresolved",
    address: target,
    agentId: null,
    machine: null,
  };
}

// ── Row content ─────────────────────────────────────────────────────────────

/**
 * The request's first readable line. Transport prefixes (`[ask:…]` tags, a
 * leading `session:<id>` address, markdown heading marks) are routing noise,
 * not what was asked. Returns null for routing failures: their `detail` is the
 * broker's explanation of the failure, and the request itself was not kept.
 */
export function dispatchRequestSummary(attempt: BrokerRouteAttempt): string | null {
  if (attempt.kind === "failed_query") return null;
  const lines = attempt.detail.split("\n");
  for (const line of lines) {
    const cleaned = line
      .replace(/^\s*(\[ask:[^\]]+\]\s*)+/i, "")
      .replace(/^\s*session:[^\s]+\s+/i, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) return cleaned;
  }
  return null;
}

export function dispatchDeliveryState(attempt: BrokerRouteAttempt): DispatchDeliveryState {
  if (brokerAttemptIsFailure(attempt)) return "attention";
  const tone = brokerAttemptTone(attempt.kind, attempt.status);
  return tone === "working" || tone === "warning" ? "pending" : "delivered";
}

export function dispatchRowModel(
  attempt: BrokerRouteAttempt,
  agents: Agent[],
  operatorName: string | null,
): DispatchRowModel {
  const request = dispatchRequestSummary(attempt);
  return {
    attempt,
    from: dispatchSenderNode(attempt, agents, operatorName),
    to: dispatchDestinationNode(attempt, agents, operatorName),
    request,
    title: request ?? dispatchRecovery(attempt).headline,
    delivery: dispatchDeliveryState(attempt),
  };
}

// ── Scope ───────────────────────────────────────────────────────────────────

export function dispatchWindowStart(window: DispatchWindow, nowMs: number): number | null {
  switch (window) {
    case "1h":
      return nowMs - 60 * 60 * 1000;
    case "24h":
      return nowMs - 24 * 60 * 60 * 1000;
    case "7d":
      return nowMs - 7 * 24 * 60 * 60 * 1000;
    case "today": {
      const start = new Date(nowMs);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    default:
      return null;
  }
}

/** Focus matches a row when either end is focused, or — `between` — both are. */
export function dispatchMatchesFocus(row: DispatchRowModel, nodes: readonly string[], between: boolean): boolean {
  if (nodes.length === 0) return true;
  const fromFocused = nodes.includes(row.from.key);
  const toFocused = nodes.includes(row.to.key);
  return between && nodes.length >= 2 ? fromFocused && toFocused : fromFocused || toFocused;
}

function dispatchMatchesQuery(row: DispatchRowModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const { attempt } = row;
  return [
    row.title,
    attempt.detail,
    row.from.label,
    row.from.address,
    row.to.label,
    row.to.address,
    attempt.id,
    attempt.messageId,
    attempt.conversationId,
  ].some((value) => value?.toLowerCase().includes(needle));
}

export function dispatchMatchesOutcome(row: DispatchRowModel, outcome: DispatchFilter): boolean {
  switch (outcome) {
    case "failed":
      return row.delivery === "attention";
    case "delivered":
      return row.delivery === "delivered";
    default:
      return true;
  }
}

export type DispatchScopeResult = {
  /** Rows matching focus, window and search — the population outcome counts are taken from. */
  scoped: DispatchRowModel[];
  /** `scoped` narrowed by outcome: what the ledger lists and the graph draws. */
  matching: DispatchRowModel[];
  counts: Record<DispatchFilter, number>;
};

/**
 * AND across filter types, OR within one. Outcome counts are faceted: each tab
 * says how many rows it would show under the same focus, window and search.
 */
export function applyDispatchScope(
  rows: DispatchRowModel[],
  scope: DispatchScope,
  nowMs: number,
): DispatchScopeResult {
  const start = dispatchWindowStart(scope.window, nowMs);
  const scoped = rows.filter((row) =>
    (start === null || row.attempt.ts >= start)
    && dispatchMatchesFocus(row, scope.nodes, scope.between)
    && dispatchMatchesQuery(row, scope.query));
  const counts: Record<DispatchFilter, number> = { all: scoped.length, delivered: 0, failed: 0 };
  for (const row of scoped) {
    if (row.delivery === "attention") counts.failed += 1;
    else if (row.delivery === "delivered") counts.delivered += 1;
  }
  return {
    scoped,
    matching: scoped.filter((row) => dispatchMatchesOutcome(row, scope.outcome)),
    counts,
  };
}

// ── Graph ───────────────────────────────────────────────────────────────────

export type DispatchGraphNode = {
  node: DispatchNode;
  count: number;
  attention: number;
  focused: boolean;
};

export type DispatchGraphEdge = {
  from: string;
  to: string;
  count: number;
  attention: number;
};

export type DispatchGraph = {
  senders: DispatchGraphNode[];
  destinations: DispatchGraphNode[];
  edges: DispatchGraphEdge[];
  /** Routes dropped to keep the graph compact. */
  hiddenRoutes: number;
  /** Focused nodes with no dispatch in the matching set. */
  quiet: DispatchNode[];
};

const GRAPH_MAX_SENDERS = 5;
const GRAPH_MAX_DESTINATIONS = 7;

function rankGraphNodes(map: Map<string, DispatchGraphNode>, limit: number): DispatchGraphNode[] {
  return [...map.values()]
    .sort((left, right) =>
      Number(right.focused) - Number(left.focused)
      || right.count - left.count
      || left.node.label.localeCompare(right.node.label))
    .slice(0, limit);
}

export function dispatchGraph(
  matching: DispatchRowModel[],
  focus: readonly string[],
  catalog: ReadonlyMap<string, DispatchNode>,
): DispatchGraph {
  const senders = new Map<string, DispatchGraphNode>();
  const destinations = new Map<string, DispatchGraphNode>();
  const edges = new Map<string, DispatchGraphEdge>();
  const bump = (map: Map<string, DispatchGraphNode>, node: DispatchNode, attention: boolean) => {
    const entry = map.get(node.key) ?? { node, count: 0, attention: 0, focused: focus.includes(node.key) };
    entry.count += 1;
    if (attention) entry.attention += 1;
    map.set(node.key, entry);
  };
  for (const row of matching) {
    const attention = row.delivery === "attention";
    bump(senders, row.from, attention);
    bump(destinations, row.to, attention);
    const edgeKey = `${row.from.key}\u0000${row.to.key}`;
    const edge = edges.get(edgeKey) ?? { from: row.from.key, to: row.to.key, count: 0, attention: 0 };
    edge.count += 1;
    if (attention) edge.attention += 1;
    edges.set(edgeKey, edge);
  }
  const shownSenders = rankGraphNodes(senders, GRAPH_MAX_SENDERS);
  const shownDestinations = rankGraphNodes(destinations, GRAPH_MAX_DESTINATIONS);
  const senderKeys = new Set(shownSenders.map((entry) => entry.node.key));
  const destinationKeys = new Set(shownDestinations.map((entry) => entry.node.key));
  const shownEdges = [...edges.values()].filter((edge) => senderKeys.has(edge.from) && destinationKeys.has(edge.to));
  const active = new Set([...senders.keys(), ...destinations.keys()]);
  return {
    senders: shownSenders,
    destinations: shownDestinations,
    edges: shownEdges,
    hiddenRoutes: edges.size - shownEdges.length,
    quiet: focus
      .filter((key) => !active.has(key))
      .map((key) => catalog.get(key) ?? { key, label: key.replace(/^(agent|addr|channel):/, ""), kind: "unresolved", address: null, agentId: null, machine: null }),
  };
}

/**
 * Every node the operator can focus: parties seen in the loaded dispatches
 * plus every known agent, so an agent with no traffic can still be focused and
 * shown as quiet rather than being impossible to pick.
 */
export function dispatchNodeCatalog(rows: DispatchRowModel[], agents: Agent[]): Map<string, DispatchNode> {
  const catalog = new Map<string, DispatchNode>();
  for (const row of rows) {
    if (!catalog.has(row.from.key)) catalog.set(row.from.key, row.from);
    if (!catalog.has(row.to.key)) catalog.set(row.to.key, row.to);
  }
  for (const agent of agents) {
    if (agent.retiredFromFleet || agent.staleLocalRegistration) continue;
    const node = agentNode(agent, null);
    if (!catalog.has(node.key)) catalog.set(node.key, node);
  }
  return catalog;
}

// ── Outcome and recovery ────────────────────────────────────────────────────

export type DispatchStage = "routing-stopped" | "delivery-failed" | "pending" | "delivered";

export type DispatchRetryStance =
  /** Resending the original request is a reasonable next step. */
  | "available"
  /** Nothing in the evidence says a resend would land differently. Offer it quietly. */
  | "ineffective"
  /** There is nothing to resend. */
  | "unavailable";

export type DispatchRecovery = {
  stage: DispatchStage;
  /** One line, as specific as the structured evidence allows. */
  headline: string;
  body: string | null;
  /** What the operator can do next, or null when nothing is needed. */
  guidance: string | null;
  retry: DispatchRetryStance;
  retryNote: string | null;
  /** False when the record kept no request text (routing failures). */
  requestRecorded: boolean;
  /** Structured fields the headline was chosen from, for the details view. */
  evidence: Array<{ label: string; value: string }>;
};

const REQUEST_NOT_RECORDED =
  "Scout didn't keep the request text with this routing failure, so it can't be resent from here. Forward a new request instead.";

function sessionWakeRecovery(reason: string, detail: string): Pick<DispatchRecovery, "headline" | "body" | "guidance"> | null {
  switch (reason) {
    case "session_live_fork_unsupported":
      return {
        headline: "This session can't receive the handoff through Scout",
        body: "The Codex session is open in another app, and Scout can't fork a live Codex session yet.",
        guidance: "Close the session where it's open and send again, or hand the request to another agent.",
      };
    case "session_live_unbound":
      return {
        headline: "The session is running outside Scout",
        body: "It is already running without a verified Scout endpoint, so Scout won't start a second writer.",
        guidance: "Attach the running session to Scout, then send again, or hand the request to another agent.",
      };
    case "session_runtime_unobserved":
      return {
        headline: "Scout couldn't check whether the session is live",
        body: detail,
        guidance: "Investigate the session's host, or hand the request to another agent.",
      };
    case "session_unknown":
      return {
        headline: "Scout doesn't know this session",
        body: detail,
        guidance: "Check the session id, or hand the request to another agent.",
      };
    case "session_host_unknown":
    case "session_not_on_host":
      return {
        headline: "The session isn't on a machine Scout can reach",
        body: detail,
        guidance: "Check which machine holds the session, or hand the request to another agent.",
      };
    default:
      return null;
  }
}

function unavailableRecovery(reason: string | null, label: string): Pick<DispatchRecovery, "headline" | "guidance"> {
  switch (reason) {
    case "manual_wake_required":
      return { headline: `${label} has to be woken by hand`, guidance: "Wake the agent, then send again, or hand the request to another agent." };
    case "retired":
      return { headline: `${label} was retired`, guidance: "Hand the request to an active agent." };
    case "superseded_registration":
    case "stale_registration":
      return { headline: `${label} points at an old registration`, guidance: "Address the agent's current registration, or hand the request to another agent." };
    case "session_reference_not_attachable":
      return { headline: `Scout can't attach to ${label}`, guidance: "Hand the request to another agent, or investigate the session." };
    default:
      return { headline: `${label} is unavailable`, guidance: "Hand the request to another agent, or investigate the route." };
  }
}

/**
 * What stopped a dispatch and what the operator can truthfully do next.
 *
 * Headlines branch on structured evidence only — `sessionWakeReason`,
 * `dispatchKind`, `diagnosticCode`, an unavailable target's reason — and fall
 * back to the generic failure title when none is present. Delivery is kept
 * apart from work: a delivered dispatch says nothing about whether the work
 * finished, which the aftermath reports separately.
 */
export function dispatchRecovery(attempt: BrokerRouteAttempt): DispatchRecovery {
  const metadata = attempt.metadata ?? {};
  const evidence: Array<{ label: string; value: string }> = [];
  const note = (label: string, value: unknown) => {
    const valueText = typeof value === "number" ? String(value) : text(value);
    if (valueText) evidence.push({ label, value: valueText });
  };

  if (attempt.kind === "failed_query") {
    const dispatchKind = text(metadata.dispatchKind);
    const wakeReason = text(metadata.sessionWakeReason);
    const diagnosticCode = text(metadata.diagnosticCode);
    const unavailableReason = text(metadata.unavailableReason);
    const asked = text(metadata.requestedLabel) ?? attempt.target ?? "the destination";
    // Quote the address as it was typed, including a leading "@".
    const label = `${asked.trim().startsWith("@") ? "@" : ""}${conciseAddressLabel(asked)}`;
    note("Resolution", dispatchKind);
    note("Session wake", wakeReason);
    note("Diagnostic", diagnosticCode);
    note("Unavailable because", unavailableReason);
    note("Candidates", metadata.candidateCount);

    const base = {
      stage: "routing-stopped" as const,
      retry: "unavailable" as const,
      retryNote: REQUEST_NOT_RECORDED,
      requestRecorded: false,
      evidence,
    };
    const wake = wakeReason ? sessionWakeRecovery(wakeReason, attempt.detail) : null;
    if (wake) return { ...base, ...wake };
    if (diagnosticCode === "ambiguous_alias_scope") {
      return { ...base, headline: `The alias “${label}” matches more than one scope`, body: attempt.detail, guidance: "Address the exact agent, or narrow the alias scope." };
    }
    if (diagnosticCode === "unknown_alias") {
      return { ...base, headline: `No alias named “${label}”`, body: attempt.detail, guidance: "Address an agent directly, or hand the request to another agent." };
    }
    switch (dispatchKind) {
      case "ambiguous":
        return { ...base, headline: `“${label}” matches more than one agent`, body: attempt.detail, guidance: "Address the exact agent, or hand the request to one." };
      case "unparseable":
        return { ...base, headline: `“${label}” isn't a valid address`, body: attempt.detail, guidance: "Hand the request to an agent by name." };
      case "unavailable":
        return { ...base, ...unavailableRecovery(unavailableReason, label), body: attempt.detail };
      case "unknown":
        // "unknown" covers both a name nothing answers to and a session that
        // exists but refused to wake; without a wake reason the broker's own
        // words are the only honest explanation.
        return { ...base, headline: `Scout couldn't route to “${label}”`, body: attempt.detail, guidance: "Hand the request to another agent, or investigate the route." };
      default:
        return { ...base, headline: brokerAttemptFailureTitle(attempt), body: attempt.detail, guidance: "Hand the request to another agent, or investigate the route." };
    }
  }

  if (brokerAttemptIsFailure(attempt)) {
    const reason = text(metadata.failureReason) ?? text(metadata.reconciledReason);
    const failureDetail = text(metadata.failureDetail) ?? text(metadata.error);
    note("Status", attempt.status);
    note("Failure reason", reason);
    note("Transport", metadata.transport);
    const stale = /stale running flight/i.test(failureDetail ?? "");
    return {
      stage: "delivery-failed",
      headline: stale ? "The destination stopped answering mid-delivery" : brokerAttemptFailureTitle(attempt),
      body: failureDetail,
      guidance: "Resend the request to the same or another agent, or investigate first.",
      retry: "available",
      retryNote: null,
      requestRecorded: true,
      evidence,
    };
  }

  const tone = brokerAttemptTone(attempt.kind, attempt.status);
  if (tone === "working" || tone === "warning") {
    note("Status", attempt.status);
    return {
      stage: "pending",
      headline: "Waiting on delivery",
      body: "The request left the sender. The broker hasn't confirmed delivery yet.",
      guidance: null,
      retry: "ineffective",
      retryNote: "Delivery is still in progress; resending now would create a second request.",
      requestRecorded: true,
      evidence,
    };
  }

  return {
    stage: "delivered",
    headline: "The request reached its destination",
    body: "Delivery is confirmed. Whether the work finished is tracked separately, below.",
    guidance: null,
    retry: "available",
    retryNote: null,
    requestRecorded: true,
    evidence,
  };
}

export function dispatchStateBadge(row: Pick<DispatchRowModel, "delivery">, recovery: DispatchRecovery): string {
  switch (recovery.stage) {
    case "routing-stopped":
      return "Needs attention · not delivered";
    case "delivery-failed":
      return "Needs attention · delivery failed";
    case "pending":
      return "Pending";
    default:
      return row.delivery === "delivered" ? "Delivered · work tracked separately" : "Delivered";
  }
}
