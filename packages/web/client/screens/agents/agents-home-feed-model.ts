import type {
  Agent,
  FleetActivity,
  FleetAsk,
  FleetState,
  Route,
  TailEvent,
} from "../../lib/types.ts";

/* ──────────────────────────────────────────────────────────────────────────
   Agents · Home feed — pure projection. Ported from the studio study
   (design/studio/app/studies/agents-home-feed), which simplifies Stream
   (studies/unified-stream) down to one unit: a POST — an agent, one sentence,
   at most one evidence line. Two bands:

     working — asks an agent is running right now (fleet.activeAsks)
     posts   — what agents said and what failed, newest first

   Posts come from broker records AND from harness sessions the broker only
   observes (the tail): a Claude or Codex session worked directly in a
   terminal never posts a message, but its latest reply is still news.

   The study's requests band was cut in review: the project list above
   already carries a declared ask.

   The feed is a projection, never a store: it reads existing records and
   drops the plumbing (routing notices, invocation bookkeeping, System status
   echoes) rather than rendering it as agent speech.
   ────────────────────────────────────────────────────────────────────────── */

export type HomePostState = "said" | "done" | "failed";

export type HomePost = {
  id: string;
  agent: string;
  harness: string | null;
  project: string | null;
  ts: number;
  state: HomePostState;
  text: string;
  /** One mono evidence line — an outcome, or "+N more" for a folded run. */
  attachment: string | null;
  /** The ask this post answers, when the prompt was folded into its reply. */
  context: { agent: string; text: string } | null;
  route: Route | null;
  /** Activity kind this post came from ("ask_failed" for failed asks). */
  kind: string;
  /** Where the detail panel reads from and links to. */
  conversationId?: string | null;
  /** Harness session the post came from, for posts worked outside Scout. */
  sessionId?: string | null;
  agentId?: string | null;
  /** Full workspace root (the project leaf is `project`). */
  root?: string | null;
};

export type HomeWorking = {
  id: string;
  agent: string;
  harness: string | null;
  task: string;
  since: number | null;
  route: Route | null;
};

/** What one agent did in one day, as a single row. */
export type HomeAgentDay = {
  id: string;
  agent: string;
  harness: string | null;
  /** Distinct project leaves, most recent first. */
  projects: string[];
  /** Newest post's time. */
  ts: number;
  /** Posts folded into this row. */
  count: number;
  failed: number;
  /** The one sentence the row leads with. */
  headline: string;
  /** One quiet line under it: the ask it answered, or a review tally. */
  aside: { kind: "context"; agent: string; text: string } | { kind: "note"; text: string } | null;
  route: Route | null;
  /** The name to show: the agent name minus a leading "<project>-" the
      /project line already says. `agent` stays the full name. */
  name: string;
  /** A status the agent led its latest post with ("DONE — …"), lifted out
      of the sentence into the row's meta. */
  status: "done" | "blocked" | null;
  /** "ack" when the latest post only promises work ("I'll review…") —
      the view dims it so results lead. */
  tone: "result" | "ack";
  /** Set on a PR review roll-up: every reviewer, latest first. */
  reviewers?: Array<{ agent: string; harness: string | null }>;
  /** The newest post's conversation, author id and workspace root — what
      the detail panel reads and links to. */
  conversationId?: string | null;
  /** The newest post's harness session, when it has no conversation. */
  sessionId?: string | null;
  agentId?: string | null;
  root?: string | null;
};

export type HomeDay = {
  /** Working days ago (0 = today); a day rolls over at 4am. */
  offset: number;
  rows: HomeAgentDay[];
};

export type HomeFeed = {
  working: HomeWorking[];
  posts: HomePost[];
  /** The agent behind most folded prompts — the operator's usual dispatcher.
      The view names a prompter only when it is someone else. */
  dispatcher: string | null;
  /** Posts regrouped as one row per agent per working day, newest first. */
  days: HomeDay[];
};

/* Agent-authored message kinds. `invocation_recorded` is routing bookkeeping
   (it duplicates the ask); `message_posted` / `status_message` are System or
   operator traffic, and failures arrive via recentCompleted with an outcome. */
const SPOKEN_KINDS = new Set(["ask_opened", "ask_replied", "agent_message", "handoff_sent"]);

/* Consecutive posts by one agent in one conversation within this window fold
   into a single post ("+N more") — a reply run reads as one thing said. */
const FOLD_WINDOW_MS = 10 * 60_000;

// Posts collapse into agent-day rows, so the window can reach further back.
const MAX_POSTS = 150;
const TEXT_MAX = 220;

/** Leading `[ask:f-…]` routing tags are envelope, not content. */
export function cleanText(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = raw
    .replace(/^\s*(\[[a-z]+:[^\]]+\]\s*)+/i, "")
    .replace(/\s+/g, " ")
    // Markdown emphasis is how a reply renders in its thread, not prose.
    .replace(/\*\*/g, "")
    // Full commit hashes are receipts, not prose — keep the short form.
    .replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/gi, "$1")
    // Home-directory paths read as ~/… — the operator knows whose home it is.
    .replace(/\/Users\/[^/\s]+\//g, "~/")
    .trim();
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1).trimEnd()}…` : text;
}

export function projectLeaf(root: string | null | undefined): string | null {
  if (!root) return null;
  const parts = root.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function conversationRoute(conversationId: string | null | undefined): Route | null {
  return conversationId ? { view: "conversation", conversationId } : null;
}

/* Activity names an actor by its bare id ("session-mu…"); the roster
   qualifies ids with branch and node ("session-mu….<branch>.<node>"). Index
   both, exact ids winning, so session agents find their harness and model. */
export function agentLookup(agents: Agent[]) {
  const byId = new Map<string, Agent>();
  const byName = new Map<string, Agent>();
  for (const agent of agents) {
    for (const bare of [agent.definitionId, agent.id.split(".")[0]]) {
      if (bare && !byId.has(bare)) byId.set(bare, agent);
    }
  }
  for (const agent of agents) {
    byId.set(agent.id, agent);
    byName.set(agent.name.toLowerCase(), agent);
    if (agent.handle) byName.set(agent.handle.toLowerCase(), agent);
  }
  return (id: string | null | undefined, name: string | null | undefined): Agent | null =>
    (id ? byId.get(id) : undefined) ?? (name ? byName.get(name.toLowerCase()) : undefined) ?? null;
}

function isSystemActor(name: string | null | undefined): boolean {
  return !name || name.trim().toLowerCase() === "system";
}

function postFromActivity(item: FleetActivity, lookup: ReturnType<typeof agentLookup>): HomePost | null {
  if (!SPOKEN_KINDS.has(item.kind) || isSystemActor(item.actorName)) return null;
  const text = cleanText(item.title ?? item.summary);
  if (!text) return null;
  const agent = lookup(item.actorId, item.actorName);
  return {
    id: `act:${item.id}`,
    agent: item.actorName ?? "agent",
    harness: item.actorHarness ?? agent?.harness ?? null,
    project: projectLeaf(item.workspaceRoot) ?? projectLeaf(agent?.projectRoot),
    ts: item.ts,
    state: "said",
    text,
    attachment: null,
    context: null,
    route: conversationRoute(item.conversationId),
    kind: item.kind,
    conversationId: item.conversationId,
    agentId: item.actorId ?? agent?.id ?? null,
    root: item.workspaceRoot ?? agent?.projectRoot ?? agent?.cwd ?? null,
  };
}

function postFromFailedAsk(ask: FleetAsk, lookup: ReturnType<typeof agentLookup>): HomePost | null {
  if (ask.status !== "failed") return null;
  const text = cleanText(ask.task);
  if (!text) return null;
  const agent = lookup(ask.agentId, ask.agentName);
  return {
    id: `ask:${ask.invocationId}`,
    agent: ask.agentName ?? agent?.name ?? "agent",
    harness: ask.harness ?? agent?.harness ?? null,
    project: projectLeaf(agent?.projectRoot),
    ts: ask.completedAt ?? ask.updatedAt,
    state: "failed",
    text,
    attachment: cleanText(ask.summary) || null,
    context: null,
    route: conversationRoute(ask.conversationId),
    kind: "ask_failed",
    conversationId: ask.conversationId,
    agentId: ask.agentId,
    root: agent?.projectRoot ?? agent?.cwd ?? null,
  };
}

/* A harness session's latest reply, observed through the tail. Sessions a
   Scout agent owns join that agent's row; the rest are named plainly
   ("claude session a2da73bf"). Thinking is how a reply forms, not what it
   says. */
const TAIL_NOISE = /^\[(?:thinking|assistant|message)\]/i;

export function postFromTail(event: TailEvent, agents: Agent[]): HomePost | null {
  if (event.kind !== "assistant" || TAIL_NOISE.test(event.summary.trim())) return null;
  const text = cleanText(event.summary);
  if (!text) return null;
  const agent = agents.find((candidate) => candidate.harnessSessionId === event.sessionId) ?? null;
  const harness = event.source || null;
  return {
    id: `tail:${event.source}:${event.sessionId}:${event.id}`,
    agent: agent?.name ?? `${harness ?? "agent"} session ${event.sessionId.slice(0, 8)}`,
    harness: agent?.harness ?? harness,
    project: projectLeaf(event.cwd) ?? (event.project || null),
    ts: event.ts,
    state: "said",
    text,
    attachment: null,
    context: null,
    route: { view: "sessions", sessionId: event.sessionId },
    kind: "tail_reply",
    conversationId: null,
    sessionId: event.sessionId,
    agentId: agent?.id ?? null,
    root: event.cwd || agent?.projectRoot || null,
  };
}

/* An agent that replied through the broker shows up in its transcript too;
   the broker record already carries that reply. */
const TAIL_ECHO_MS = 2 * 60_000;

function isBrokerEcho(post: HomePost, broker: HomePost[]): boolean {
  if (!post.agentId) return false;
  return broker.some((other) => other.agentId === post.agentId && Math.abs(other.ts - post.ts) < TAIL_ECHO_MS);
}

// Kinds that can answer an earlier message; agent-to-agent handoffs answer too.
const REPLY_KINDS = new Set(["ask_opened", "ask_replied", "handoff_sent"]);

function sameRoute(a: Route | null, b: Route | null): boolean {
  return Boolean(a && b) && JSON.stringify(a) === JSON.stringify(b);
}

/* A dispatch prompt and the reply it produced are one exchange: the reply is
   the news, the prompt is its context. Newest-first: each reply claims the
   nearest older message from a different agent in the same conversation. */
export function foldPrompts(sorted: HomePost[]): HomePost[] {
  const out: HomePost[] = [];
  const awaiting: HomePost[] = [];
  for (const post of sorted) {
    const reply = post.state === "said"
      ? awaiting.find((r) => r.agent !== post.agent && sameRoute(r.route, post.route))
      : undefined;
    if (reply) {
      reply.context = { agent: post.agent, text: post.text };
      awaiting.splice(awaiting.indexOf(reply), 1);
      continue;
    }
    const copy = { ...post };
    out.push(copy);
    if (REPLY_KINDS.has(copy.kind)) awaiting.push(copy);
  }
  return out;
}

/** Newest-first posts; same agent + conversation runs fold into the newest. */
export function foldRuns(sorted: HomePost[]): HomePost[] {
  const out: HomePost[] = [];
  const folded = new Map<string, number>();
  for (const post of sorted) {
    const prev = out[out.length - 1];
    const sameRun = prev
      && prev.state === "said"
      && post.state === "said"
      && prev.agent === post.agent
      && sameRoute(prev.route, post.route)
      && prev.ts - post.ts <= FOLD_WINDOW_MS;
    if (sameRun && prev) {
      const n = (folded.get(prev.id) ?? 0) + 1;
      folded.set(prev.id, n);
      prev.attachment = `+${n} more in the thread`;
      continue;
    }
    out.push({ ...post });
  }
  return out;
}

/* One agent usually dispatches everything ("Openscout Agent 2" on nearly
   every reply line). Naming it on each row is repetition, not information:
   the usual dispatcher is whoever holds at least half the folded prompts
   (and at least two), and only a different prompter gets named. */
export function usualDispatcher(posts: HomePost[]): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const post of posts) {
    if (!post.context) continue;
    total += 1;
    counts.set(post.context.agent, (counts.get(post.context.agent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [agent, count] of counts) {
    if (count > bestCount) [best, bestCount] = [agent, count];
  }
  return bestCount >= 2 && bestCount * 2 >= total ? best : null;
}

/* ── Grouping: one row per agent per working day ───────────────────────── */

const DAY_MS = 86_400_000;
/* A working day ends at 4am, not midnight — at 00:30 the last hour's posts
   still belong to "today". */
const DAY_ROLLOVER_MS = 4 * 3_600_000;

export function dayOffset(ts: number, nowMs: number): number {
  const start = (ms: number) => {
    const d = new Date(ms - DAY_ROLLOVER_MS);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  return Math.max(0, Math.round((start(nowMs) - start(ts)) / DAY_MS));
}

/* Review verdicts ("APPROVE at c39dc82 …", "CHANGES at …") are one fact —
   a PR got reviewed — repeated per re-check. They collapse into a tally. */
const VERDICT = /^(?:verdict:\s*)?(approved?|lgtm|changes(?:\s+requested)?|request(?:ed)?\s+changes|block(?:ed)?|reject(?:ed)?)\b/i;
const PR_REF = /(?:\bPR\s*#?|#|\/pull\/)(\d{2,6})\b/gi;

export function verdictOf(text: string): "approved" | "changes" | "blocked" | null {
  const match = VERDICT.exec(text);
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  if (word.startsWith("appro") || word === "lgtm") return "approved";
  if (word.startsWith("block") || word.startsWith("reject")) return "blocked";
  return "changes";
}

function prRefs(texts: Array<string | null | undefined>): string[] {
  const refs = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(PR_REF)) refs.add(`#${match[1]}`);
  }
  return [...refs];
}

const VERDICT_LABEL = { approved: "Approved", changes: "Requested changes", blocked: "Blocked" } as const;

/* "openscout-fourier" in /openscout is just "fourier" on the row. */
export function displayName(agent: string, project: string | null | undefined): string {
  if (!project) return agent;
  const prefix = `${project.toLowerCase()}-`;
  const rest = agent.toLowerCase().startsWith(prefix) ? agent.slice(prefix.length) : "";
  return rest ? rest : agent;
}

/* Agents often lead a report with a status word: "DONE — landed …". */
const STATUS_LEAD = /^(done|blocked)\s*(?:[—–:-]\s*|\.\s+)/i;

export function liftStatus(text: string): { status: "done" | "blocked" | null; text: string } {
  const match = STATUS_LEAD.exec(text);
  if (!match) return { status: null, text };
  const rest = text.slice(match[0].length);
  return {
    status: match[1]!.toLowerCase() === "done" ? "done" : "blocked",
    text: rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : text,
  };
}

/* A feed row leads with the agent's first sentence — usually the whole
   thought ("Workflow Planner study landed in the studio."). A very short
   opener ("Done.") keeps its second sentence too. */
export function leadSentence(text: string, max = 180): string {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9`~/#(])/);
  let lead = parts[0] ?? text;
  if (lead.length < 24 && parts[1]) lead = `${lead} ${parts[1]}`;
  if (lead.length > max) lead = `${lead.slice(0, max - 1).trimEnd()}…`;
  return lead;
}

/* A post that only says what the agent is about to do is an acknowledgment,
   not news. */
const ACK_LEAD = /^(i'll|i will|i'm going to|i am going to|starting|on it|will\s|let me|going to)\b/i;

export function isAck(text: string): boolean {
  return ACK_LEAD.test(text.trim());
}

function agentDayRow(posts: HomePost[]): HomeAgentDay {
  const latest = posts[0]!;
  const projects = [...new Set(posts.map((p) => p.project).filter((p): p is string => Boolean(p)))];
  const failed = posts.filter((p) => p.state === "failed").length;
  const reviews = posts.filter((p) => p.state === "said" && verdictOf(p.text));
  const latestVerdict = latest.state === "said" ? verdictOf(latest.text) : null;

  const lifted = liftStatus(latest.text);
  let headline = leadSentence(lifted.text);
  let aside: HomeAgentDay["aside"] = latest.context
    ? { kind: "context", agent: latest.context.agent, text: latest.context.text }
    : latest.attachment
      ? { kind: "note", text: latest.attachment }
      : null;

  if (latestVerdict) {
    const refs = prRefs([latest.text, latest.context?.text]);
    const rest = leadSentence(latest.text.replace(VERDICT, "").replace(/^[\s:—–.-]+/, ""));
    headline = refs.length
      ? `${VERDICT_LABEL[latestVerdict]} ${refs.join(", ")}`
      : [VERDICT_LABEL[latestVerdict], rest].filter(Boolean).join(" · ");
    if (reviews.length > 1) {
      const allRefs = prRefs(reviews.flatMap((p) => [p.text, p.context?.text]));
      const shown = allRefs.slice(0, 3).join(", ");
      const more = allRefs.length > 3 ? ` +${allRefs.length - 3}` : "";
      aside = { kind: "note", text: `${reviews.length} reviews${allRefs.length ? ` on ${shown}${more}` : ""}` };
    }
  }

  return {
    id: `${latest.agent}:${latest.id}`,
    agent: latest.agent,
    harness: latest.harness ?? posts.find((p) => p.harness)?.harness ?? null,
    projects,
    ts: latest.ts,
    count: posts.length,
    failed,
    headline,
    aside,
    route: latest.route,
    name: displayName(latest.agent, projects[0]),
    status: latestVerdict ? null : lifted.status,
    tone: !latestVerdict && latest.state === "said" && isAck(headline) ? "ack" : "result",
    conversationId: latest.conversationId ?? null,
    sessionId: latest.sessionId ?? null,
    agentId: latest.agentId ?? null,
    root: latest.root ?? posts.find((p) => p.root)?.root ?? null,
  };
}

/* Several agents reviewing one PR is one story — "#1017 · 3 approved,
   2 requested changes" — not five rows. A reviewer's latest verdict
   supersedes their earlier re-checks. */
function reviewRow(pr: string, posts: HomePost[]): HomeAgentDay {
  const latest = posts[0]!;
  const latestByReviewer = new Map<string, HomePost>();
  for (const post of posts) if (!latestByReviewer.has(post.agent)) latestByReviewer.set(post.agent, post);
  const tally = { approved: 0, changes: 0, blocked: 0 };
  for (const post of latestByReviewer.values()) {
    const verdict = verdictOf(post.text);
    if (verdict) tally[verdict] += 1;
  }
  const parts = [
    tally.approved ? `${tally.approved} approved` : null,
    tally.changes ? `${tally.changes} requested changes` : null,
    tally.blocked ? `${tally.blocked} blocked` : null,
  ].filter(Boolean);
  const reviewers = [...latestByReviewer.values()].map((p) => ({ agent: p.agent, harness: p.harness }));
  const latestVerdict = verdictOf(latest.text);
  return {
    id: `review:${pr}:${latest.id}`,
    agent: latest.agent,
    harness: latest.harness,
    projects: [...new Set(posts.map((p) => p.project).filter((p): p is string => Boolean(p)))],
    ts: latest.ts,
    count: posts.length,
    failed: 0,
    headline: `Review of ${pr} · ${parts.join(", ")}`,
    aside: {
      kind: "note",
      text: `latest: ${latest.agent}${latestVerdict ? ` — ${VERDICT_LABEL[latestVerdict].toLowerCase()}` : ""}`,
    },
    route: latest.route,
    name: latest.agent,
    status: null,
    tone: "result",
    reviewers,
    conversationId: latest.conversationId ?? null,
    sessionId: latest.sessionId ?? null,
    agentId: latest.agentId ?? null,
    root: latest.root ?? posts.find((p) => p.root)?.root ?? null,
  };
}

function reviewedPr(post: HomePost, prByRoute: Map<string, string>): string | null {
  if (post.state !== "said" || !verdictOf(post.text)) return null;
  return prRefs([post.text, post.context?.text])[0]
    ?? (post.route ? prByRoute.get(JSON.stringify(post.route)) : undefined)
    ?? null;
}

/** Newest-first posts → working days → rows (PR review roll-ups, then one
    row per agent), newest first. */
export function groupByAgentDay(posts: HomePost[], nowMs: number): HomeDay[] {
  const days = new Map<number, { byPr: Map<string, HomePost[]>; byAgent: Map<string, HomePost[]> }>();
  const push = (map: Map<string, HomePost[]>, key: string, post: HomePost) => {
    const list = map.get(key) ?? [];
    list.push(post);
    map.set(key, list);
  };
  // A re-check often drops the PR number; its conversation still names it.
  const prByRoute = new Map<string, string>();
  for (const post of posts) {
    const ref = post.route && verdictOf(post.text) ? prRefs([post.text, post.context?.text])[0] : undefined;
    const key = post.route ? JSON.stringify(post.route) : null;
    if (ref && key && !prByRoute.has(key)) prByRoute.set(key, ref);
  }
  for (const post of posts) {
    const offset = dayOffset(post.ts, nowMs);
    const day = days.get(offset) ?? { byPr: new Map(), byAgent: new Map() };
    days.set(offset, day);
    const pr = reviewedPr(post, prByRoute);
    if (pr) push(day.byPr, pr, post);
    else push(day.byAgent, post.agent, post);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a - b)
    .map(([offset, day]) => ({
      offset,
      rows: [
        ...[...day.byPr.entries()].map(([pr, list]) =>
          new Set(list.map((p) => p.agent)).size > 1 || list.length > 1 ? reviewRow(pr, list) : agentDayRow(list),
        ),
        ...[...day.byAgent.values()].map(agentDayRow),
      ].sort((a, b) => b.ts - a.ts),
    }));
}

export function buildHomeFeed({
  fleet,
  agents,
  tail = [],
  nowMs = Date.now(),
}: {
  fleet: FleetState | null;
  agents: Agent[];
  /** Latest assistant reply per harness session (`/api/tail/recent?mode=assistant-replies`). */
  tail?: TailEvent[];
  nowMs?: number;
}): HomeFeed {
  const lookup = agentLookup(agents);

  const working: HomeWorking[] = (fleet?.activeAsks ?? [])
    .filter((ask) => ask.status === "working" || ask.status === "queued")
    .map((ask) => ({
      id: ask.invocationId,
      agent: ask.agentName ?? lookup(ask.agentId, null)?.name ?? "agent",
      harness: ask.harness ?? lookup(ask.agentId, ask.agentName)?.harness ?? null,
      task: cleanText(ask.task),
      since: ask.startedAt ?? ask.updatedAt,
      route: conversationRoute(ask.conversationId),
    }));

  const raw: HomePost[] = [
    ...(fleet?.activity ?? []).map((item) => postFromActivity(item, lookup)),
    ...(fleet?.recentCompleted ?? []).map((ask) => postFromFailedAsk(ask, lookup)),
  ].filter((p): p is HomePost => Boolean(p));
  const observed = tail
    .map((event) => postFromTail(event, agents))
    .filter((p): p is HomePost => Boolean(p) && !isBrokerEcho(p!, raw));
  raw.push(...observed);
  raw.sort((a, b) => b.ts - a.ts);

  const posts = foldRuns(foldPrompts(raw)).slice(0, MAX_POSTS);
  return {
    working,
    posts,
    dispatcher: usualDispatcher(posts),
    days: groupByAgentDay(posts, nowMs),
  };
}

/** Index of the first post the operator had already seen, or -1. */
export function seenBoundary(posts: Array<{ ts: number }>, lastSeenAt: number | null): number {
  if (!lastSeenAt) return -1;
  const index = posts.findIndex((post) => post.ts <= lastSeenAt);
  // A rule above the very first row says nothing new happened — skip it.
  return index <= 0 ? -1 : index;
}
