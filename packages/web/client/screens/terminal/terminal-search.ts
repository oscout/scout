import { agentStateLabel, isAgentOnline } from "../../lib/agent-state.ts";
import type { TerminalListItem } from "../../lib/terminal-sessions.ts";
import type { Agent } from "../../lib/types.ts";
import { terminalSessionActivityAt, terminalSessionStateRank } from "./session-table.ts";

/**
 * Finding a terminal is not filtering a list.
 *
 * The rail used to hold one flat `searchable` blob per session and keep the
 * rows whose blob contained the typed substring. That answers "which of these
 * mention openscout", which on a host where every session is in one repo is
 * every row — and it answers it in whatever order the list already had, so the
 * session you are actually looking for is as likely to be last as first.
 *
 * What an operator asks is narrower and ranked: the claude one in this repo,
 * the one that is live, the one where that migration is running. So matching
 * here knows which field it hit — a session NAMED `deploy` outranks one that
 * merely sits in a directory containing the word — a query can name the field
 * itself (`harness:claude`, `is:live`, `-exited`), and what is on the screen
 * right now is searchable alongside the metadata, because the thing you
 * remember about a terminal is usually what it was printing.
 */

/** One clause of a query. Bare words match anywhere; `field:value` is scoped. */
export type TerminalSearchTerm = {
  /** Field to match in, or null for "anywhere". */
  field: string | null;
  value: string;
  /** `-term` / `-field:value` — the clause must NOT match. */
  negated: boolean;
};

/**
 * A searchable terminal, flattened out of whatever it came from. Sessions,
 * discovered multiplexer setups and agent-owned surfaces are all found the
 * same way, so they are all reduced to this before matching.
 */
export type TerminalSearchTarget = {
  id: string;
  /** The session's own name — the strongest signal there is. */
  name: string;
  project: string;
  cwd: string;
  harness: string;
  backend: string;
  /** What the session is running, when the host reports it. */
  command: string;
  /** Host-reported state wording ("2 attached", "detached", "exited"). */
  condition: string;
  /** Who runs it: the owning agent's name and handle, when an agent owns the surface. */
  owner?: string;
  kind: "multiplexer" | "agent" | "session";
  /**
   * What an owning agent lends the row beyond its name. These are the answers
   * to "the claude one on the release branch", "the one running opus", "the one
   * the broker just delivered that ask to" — none of which is in the session
   * record, all of which the operator remembers. Absent on a row no agent owns.
   */
  branch?: string;
  model?: string;
  role?: string;
  /** The node the agent answers on: home and authority, when they differ. */
  node?: string;
  /**
   * What the broker has carried for this agent lately — kinds, states and
   * summaries, flattened. Already on the roster, so unlike `screen` it costs
   * nothing to match; absent when the payload came without broker context.
   */
  delivery?: string;
  live: boolean;
  /** Epoch ms of last activity, or null when the host does not report one. */
  activityAt: number | null;
  /**
   * The visible screen, when it has been captured. Absent means "not fetched",
   * which is not the same as "no match" — see `terminalSearchNeedsScreens`.
   */
  screen?: string;
  /**
   * What is open INSIDE a multiplexer session: one line per pane, carrying the
   * desk and tab it sits in, the pane's own title, and the agent on it. A herdr
   * session is one row here but a dozen places to be, and the name of the one
   * you want is never the session's — see `terminalSearchNeedsPanes`.
   */
  panes?: string;
};

export type TerminalSearchHit<T> = {
  target: TerminalSearchTarget;
  item: T;
  score: number;
  /** Fields this query hit, best first — what the row can show as its reason. */
  matchedOn: string[];
  /** The matching line, when the hit came from a field that holds many. */
  excerpt: string | null;
  /** Which field the excerpt was quoted from, so a row can name it. */
  excerptField: string | null;
};

/** Field names a query may scope to, and the aliases that are kinder to type. */
const FIELD_ALIASES: Record<string, string> = {
  name: "name",
  session: "name",
  title: "name",
  project: "project",
  repo: "project",
  in: "project",
  cwd: "cwd",
  path: "cwd",
  dir: "cwd",
  harness: "harness",
  agent: "harness",
  owner: "owner",
  by: "owner",
  backend: "backend",
  host: "backend",
  mux: "backend",
  multiplexer: "backend",
  branch: "branch",
  model: "model",
  role: "role",
  node: "node",
  machine: "node",
  delivery: "delivery",
  msg: "delivery",
  message: "delivery",
  cmd: "command",
  command: "command",
  run: "command",
  screen: "screen",
  output: "screen",
  pane: "panes",
  panes: "panes",
  inside: "panes",
  is: "is",
  state: "is",
};

/**
 * What a bare word is worth in each field.
 *
 * The ordering is the opinion: a session's own name is what you named it, so a
 * hit there is nearly always the one you meant. A directory hit is weak — on a
 * single-repo host every session shares one — and exists mostly so that typing
 * a path you remember still narrows something.
 */
const FIELD_WEIGHT: Record<string, number> = {
  name: 100,
  owner: 80,
  command: 60,
  // A pane title is something herdr or the agent deliberately wrote, so it is
  // a better handle than scrollback that merely happened to scroll past.
  panes: 55,
  screen: 50,
  // A message you remember the wording of is nearly as good a handle as a name,
  // and much better than the directory everything shares.
  delivery: 45,
  project: 40,
  harness: 34,
  branch: 30,
  model: 26,
  role: 26,
  backend: 24,
  condition: 20,
  node: 20,
  cwd: 18,
};

/**
 * Fields that hold many lines behind one row. A hit in one of these names a row
 * for a reason nothing on the row shows, so the matching line travels with the
 * hit and the row quotes it.
 */
const EXCERPTED_FIELDS = new Set(["screen", "panes", "delivery"]);

const MATCHABLE_FIELDS = [
  "name", "owner", "command", "panes", "screen", "delivery", "project",
  "harness", "branch", "model", "role", "backend", "condition", "cwd",
] as const;

/**
 * Split a raw query into clauses.
 *
 * Quoted runs stay whole (`cmd:"bun test"`), a leading `-` negates, and a
 * trailing bare `field:` is dropped rather than treated as a literal — it is
 * what a half-typed scope looks like, and matching on it would empty the list
 * under the operator's fingers.
 */
export function parseTerminalQuery(raw: string): TerminalSearchTerm[] {
  const terms: TerminalSearchTerm[] = [];
  // field:"quoted value" | field:value | "quoted" | bare
  const pattern = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  for (const match of raw.matchAll(pattern)) {
    const [, minus, rawField, quoted, bare] = match;
    const value = (quoted ?? bare ?? "").trim().toLowerCase();
    const field = rawField ? FIELD_ALIASES[rawField.toLowerCase()] ?? null : null;
    // `project:` with nothing after it, or a scope we do not know, is a query
    // in progress. Unknown scopes fall back to matching the whole token so a
    // typo narrows oddly rather than silently matching everything.
    if (!value) continue;
    // `project:` on its own — a scope the operator is halfway through typing.
    // The regex reads it as the bare word "project:", which would match nothing
    // and blank the list at the exact moment they are still saying what they want.
    if (!rawField && value.endsWith(":") && FIELD_ALIASES[value.slice(0, -1)]) continue;
    if (rawField && field === null) {
      terms.push({ field: null, value: `${rawField.toLowerCase()}:${value}`, negated: minus === "-" });
      continue;
    }
    terms.push({ field, value, negated: minus === "-" });
  }
  return terms;
}

/** True when any clause of this query can only be answered by a screen capture. */
export function terminalSearchNeedsScreens(terms: TerminalSearchTerm[]): boolean {
  return terms.some((term) => term.field === "screen");
}

/**
 * True when a clause asks what the broker carried. The roster every screen
 * holds is the summary projection, which leaves broker activity out; this says
 * when it has to be fetched in full.
 */
export function terminalSearchNeedsDelivery(terms: TerminalSearchTerm[]): boolean {
  return terms.some((term) => term.field === "delivery");
}

/**
 * True when a clause asks about what is inside a session rather than about the
 * session itself. Like screens, the topology behind it is fetched per query and
 * never speculatively — it is a call per multiplexer session on the host.
 */
export function terminalSearchNeedsPanes(terms: TerminalSearchTerm[]): boolean {
  return terms.some((term) => term.field === "panes");
}

function fieldValue(target: TerminalSearchTarget, field: string): string {
  switch (field) {
    case "name": return target.name;
    case "owner": return target.owner ?? "";
    case "project": return target.project;
    case "cwd": return target.cwd;
    case "harness": return target.harness;
    case "backend": return target.backend;
    case "branch": return target.branch ?? "";
    case "model": return target.model ?? "";
    case "role": return target.role ?? "";
    case "node": return target.node ?? "";
    case "delivery": return target.delivery ?? "";
    case "command": return target.command;
    case "condition": return target.condition;
    case "screen": return target.screen ?? "";
    case "panes": return target.panes ?? "";
    default: return "";
  }
}

/**
 * How well one value answers one word. Whole-value and word-start hits are
 * worth more than a substring buried inside another word, so `dev` prefers the
 * session called `dev` over `openscout-devtools`.
 */
function matchStrength(value: string, needle: string): number {
  if (!value || !needle) return 0;
  const haystack = value.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at < 0) return 0;
  if (haystack === needle) return 1;
  const before = at === 0 ? "" : haystack[at - 1]!;
  const atWordStart = at === 0 || !/[a-z0-9]/.test(before);
  return atWordStart ? 0.75 : 0.4;
}

/** `is:` answers about state rather than text, so it is matched, not scored. */
function matchesState(target: TerminalSearchTarget, value: string): boolean {
  switch (value) {
    case "live": case "running": case "active": return target.live;
    case "idle": case "inactive": case "dead": case "exited": return !target.live;
    case "agent": return target.kind === "agent" || Boolean(target.owner);
    case "multiplexer": case "multi":
      return target.kind === "multiplexer";
    // Named by backend rather than by which list the row came from: an agent's
    // surface running under tmux is a tmux terminal, whatever discovered it.
    case "herdr": case "tmux": case "zellij":
      return target.backend.toLowerCase() === value;
    case "session": case "plain": return target.kind === "session";
    default:
      // Unknown `is:` values fall through to the condition wording, so
      // `is:attached` works on a host that reports it without a special case.
      return target.condition.toLowerCase().includes(value);
  }
}

/**
 * Recency, as a multiplier between 1 and about 1.5.
 *
 * Deliberately gentle: it separates two sessions that match equally well
 * without letting "touched a minute ago" outrank the session you actually
 * named. A host that reports no activity is not penalised — a discovered
 * session has no activity stamp, only a probe time, and sinking it for that
 * would hide exactly the long-lived setups this search is for.
 */
function recencyBoost(activityAt: number | null, now: number): number {
  if (activityAt === null || activityAt <= 0) return 1;
  const hours = Math.max(0, now - activityAt) / 3_600_000;
  return 1 + 0.5 / (1 + hours);
}

/**
 * Score one target against one parsed query.
 *
 * Every clause must be satisfied — this is an AND, because each word an
 * operator adds is an attempt to narrow — and a clause satisfied in a strong
 * field carries the row up. Returns null when the target is out.
 */
export function scoreTerminalTarget(
  target: TerminalSearchTarget,
  terms: TerminalSearchTerm[],
  now: number,
): { score: number; matchedOn: string[]; excerpt: string | null; excerptField: string | null } | null {
  if (terms.length === 0) {
    return { score: terminalSearchIdleScore(target, now), matchedOn: [], excerpt: null, excerptField: null };
  }
  let score = 0;
  const matched = new Map<string, number>();
  let excerpt: string | null = null;
  let excerptField: string | null = null;

  for (const term of terms) {
    if (term.field === "is") {
      const hit = matchesState(target, term.value);
      if (hit === term.negated) return null;
      if (hit) score += 30;
      continue;
    }
    const fields = term.field ? [term.field] : MATCHABLE_FIELDS;
    let best = 0;
    let bestField = "";
    for (const field of fields) {
      const strength = matchStrength(fieldValue(target, field), term.value);
      if (strength <= 0) continue;
      const weighted = strength * (FIELD_WEIGHT[field] ?? 10);
      if (weighted > best) { best = weighted; bestField = field; }
    }
    if (term.negated) {
      if (best > 0) return null;
      continue;
    }
    if (best <= 0) return null;
    score += best;
    matched.set(bestField, Math.max(matched.get(bestField) ?? 0, best));
    // These are all many lines of text behind one row, so the row has to be
    // able to say WHICH line answered — a pane name or a delivered message as
    // much as a screen.
    if (EXCERPTED_FIELDS.has(bestField) && !excerpt) {
      excerpt = screenExcerpt(fieldValue(target, bestField), term.value);
      if (excerpt) excerptField = bestField;
    }
  }

  return {
    score: score * recencyBoost(target.activityAt, now) + (target.live ? 12 : 0),
    matchedOn: [...matched.entries()].sort((left, right) => right[1] - left[1]).map(([field]) => field),
    excerpt,
    excerptField,
  };
}

/**
 * Ordering with no query at all: live first, then most recently active. The
 * empty search is the list you see before typing, and it should already be the
 * list you most often want.
 */
function terminalSearchIdleScore(target: TerminalSearchTarget, now: number): number {
  return (target.live ? 1_000 : 0) + recencyBoost(target.activityAt, now) * 10;
}

/** The most relevant line of captured screen, trimmed to something readable. */
export function screenExcerpt(screen: string, needle: string, width = 120): string | null {
  if (!screen || !needle) return null;
  for (const line of screen.split("\n")) {
    const at = line.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const trimmed = line.trim();
    if (trimmed.length <= width) return trimmed;
    // Keep the match in frame rather than always showing the head of the line.
    const start = Math.max(0, at - Math.floor(width / 3));
    return `${start > 0 ? "…" : ""}${line.slice(start, start + width).trim()}${start + width < line.length ? "…" : ""}`;
  }
  return null;
}

/**
 * Rank targets against a raw query string. Ties break on recency, then name,
 * so the order is stable between keystrokes instead of shuffling on refresh.
 */
export function searchTerminalTargets<T>(
  entries: ReadonlyArray<{ target: TerminalSearchTarget; item: T }>,
  query: string,
  now = Date.now(),
): TerminalSearchHit<T>[] {
  const terms = parseTerminalQuery(query);
  const hits: TerminalSearchHit<T>[] = [];
  for (const entry of entries) {
    const scored = scoreTerminalTarget(entry.target, terms, now);
    if (!scored) continue;
    hits.push({
      target: entry.target,
      item: entry.item,
      score: scored.score,
      matchedOn: scored.matchedOn,
      excerpt: scored.excerpt,
      excerptField: scored.excerptField,
    });
  }
  return hits.sort((left, right) =>
    right.score - left.score
    || (right.target.activityAt ?? 0) - (left.target.activityAt ?? 0)
    || left.target.name.localeCompare(right.target.name));
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

/** Flatten a rail/picker row into the shape matching understands. */
export function terminalSearchTargetOf(
  item: TerminalListItem,
  options: {
    kind?: TerminalSearchTarget["kind"];
    screen?: string;
    panes?: string;
    owner?: string;
  } & TerminalSearchAgentFacets = {},
): TerminalSearchTarget {
  return {
    id: item.id,
    name: item.title || item.surface.sessionName,
    owner: options.owner ?? "",
    branch: options.branch ?? "",
    model: options.model ?? "",
    role: options.role ?? "",
    node: options.node ?? "",
    delivery: options.delivery ?? "",
    project: item.project,
    cwd: item.session.cwd || item.cwdLabel,
    harness: item.session.harness,
    backend: item.surface.backend,
    command: metadataString(item.session.metadata, "currentCommand"),
    condition: item.condition,
    kind: options.kind ?? (item.origin === "backend" ? "multiplexer" : "session"),
    live: terminalSessionStateRank(item) > 0,
    activityAt: terminalSessionActivityAt(item),
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.panes === undefined ? {} : { panes: options.panes }),
  };
}

/** The words an owning agent lends its row: its name and handle. */
export function terminalSearchOwner(agent: Agent): string {
  return [agent.name, agent.handle ? `@${agent.handle}` : ""].filter(Boolean).join(" ");
}

export type TerminalSearchAgentFacets = {
  owner?: string;
  branch?: string;
  model?: string;
  role?: string;
  node?: string;
  delivery?: string;
};

/**
 * Everything an owning agent lends a row, in one place so a session found on
 * the host and the same agent found on the roster answer to the same words.
 */
export function terminalSearchAgentFacets(agent: Agent): TerminalSearchAgentFacets {
  return {
    owner: terminalSearchOwner(agent),
    branch: agent.branch ?? "",
    model: agent.model ?? "",
    // `role` is the operator's word for it; `agentClass` is the registry's, and
    // is all a lot of agents have.
    role: agent.role ?? agent.agentClass ?? "",
    node: [agent.homeNodeName, agent.authorityNodeName]
      .filter((name): name is string => Boolean(name))
      .filter((name, index, all) => all.indexOf(name) === index)
      .join(" "),
    delivery: terminalSearchDelivery(agent),
  };
}

/**
 * What the broker has carried for this agent lately, flattened for matching:
 * each event's kind, its state, and the summary line. One line per event so a
 * `delivery:` hit cannot be assembled out of two unrelated messages.
 */
export function terminalSearchDelivery(agent: Agent): string {
  return (agent.brokerActivity ?? [])
    .map((event) => [event.kind, event.state ?? "", event.summary].filter(Boolean).join(" "))
    .join("\n");
}

/**
 * An agent with no terminal on the host right now — its surface exited, or it
 * runs without one — still answers to its name, handle, harness and project,
 * and can still be opened. It searches as a row of its own.
 */
export function terminalSearchTargetOfAgent(
  agent: Agent,
  options: { backend?: string | null; live?: boolean } = {},
): TerminalSearchTarget {
  return {
    id: `agent:${agent.id}`,
    name: agent.name,
    ...terminalSearchAgentFacets(agent),
    project: agent.project ?? agent.projectRoot ?? "",
    cwd: agent.cwd ?? agent.projectRoot ?? "",
    harness: agent.harness ?? "",
    backend: options.backend ?? agent.transport ?? "",
    command: "",
    condition: agentStateLabel(agent.state, agent),
    kind: "agent",
    // The caller knows whether the host still lists the agent's surface; an
    // agent that runs without one is as live as the roster says it is.
    live: options.live ?? isAgentOnline(agent.state, agent),
    activityAt: agent.updatedAt,
  };
}

/**
 * What a ranked row should mark: the bare words on its name and directory, and
 * the words of a quoted line — screen, pane or delivered message — on that
 * line. Negated clauses and other scoped fields narrow the list but mark
 * nothing.
 */
export type TerminalSearchHighlight = { text: string[]; screen: string[] };

export function terminalSearchHighlight(terms: readonly TerminalSearchTerm[]): TerminalSearchHighlight {
  const text: string[] = [];
  const screen: string[] = [];
  for (const term of terms) {
    if (term.negated || !term.value) continue;
    if (term.field === null) text.push(term.value);
    // A pane or delivery hit is shown on the same excerpt line a screen hit is,
    // so it marks there rather than on the row's name.
    else if (EXCERPTED_FIELDS.has(term.field)) screen.push(term.value);
  }
  return { text, screen };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `text` into runs, flagging the ones that are one of `needles`, case-insensitively. */
export function markMatches(
  text: string,
  needles: readonly string[],
): Array<{ text: string; match: boolean }> {
  const live = needles.filter((needle) => needle.length > 0);
  if (!text || live.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(`(${live.map(escapeForRegExp).join("|")})`, "ig");
  return text
    .split(pattern)
    .map((part, index) => ({ text: part, match: index % 2 === 1 }))
    .filter((run) => run.text.length > 0);
}
