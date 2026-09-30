/**
 * Agent notifications: what an agent's notification IS, so the phone can pick
 * the view that fits it.
 *
 * Every notification declares a `view` and the typed fields that view needs.
 * The same record renders in three places: the lock screen (text only, via
 * {@link collapseAgentNotification}), the long-press view, and the app's
 * Notifications row. A client that doesn't know a `view` renders `text`.
 *
 * Everything that wants the operator is a question of some kind; the prefix
 * says WHEN it was asked:
 *   - `turn.*` is mid-turn: the turn is paused until the operator answers.
 *   - `ask` is outside a turn: the agent finished and reached out on its own.
 * Only declared things become notifications. Inferred attention never does.
 *
 * The record travels sealed (see the runtime's mobile-push sealing): the relay
 * that delivers the push never reads any of it.
 */

export const AGENT_NOTIFICATION_VERSION = 1 as const;

export type AgentNotificationRisk = "low" | "medium" | "high";

export type AgentNotificationFileChange = {
  path: string;
  added: number;
  removed: number;
};

export type AgentNotificationArtifact = {
  kind: "pr" | "build" | "file" | "link";
  label: string;
  meta?: string;
  url?: string;
};

export type AgentNotificationView =
  | { view: "turn.approve.command"; command: string; cwd?: string; risk: AgentNotificationRisk; why?: string }
  | { view: "turn.approve.edit"; summary?: string; files: AgentNotificationFileChange[]; risk: AgentNotificationRisk }
  | { view: "turn.approve.tool"; tool: string; summary?: string; risk: AgentNotificationRisk }
  | { view: "turn.question.choice"; question: string; context?: string; options: string[]; multiSelect?: boolean }
  | { view: "turn.question.open"; question: string; context?: string }
  | { view: "turn.failed"; error: string; excerpt?: string[]; elapsed?: string }
  | { view: "work.done"; summary: string; artifacts?: AgentNotificationArtifact[] }
  | { view: "ask"; note: string; options?: string[] }
  | { view: "text"; title: string; body?: string };

export type AgentNotificationViewName = AgentNotificationView["view"];

export type AgentNotificationAction =
  | "approve"
  | "deny"
  | "reply"
  | "open_chat"
  | "open_link";

export type AgentNotification = AgentNotificationView & {
  v: typeof AGENT_NOTIFICATION_VERSION;
  /** Stable id of the thing that wants attention (inbox item, message). */
  itemId: string;
  /** The agent, as the operator knows it. */
  sender: { name: string; agentId?: string };
  project?: string;
  /** The Mac it happened on. */
  host?: string;
  /** Declared and still open: Time Sensitive on the lock screen, Priority in the app. */
  urgent: boolean;
  createdAt: number;
  /** Routing back into the app. */
  route?: {
    sessionId?: string;
    turnId?: string;
    blockId?: string;
    conversationId?: string;
    messageId?: string;
  };
};

export type AgentNotificationCollapse = {
  /** Lock-screen title: the agent. */
  title: string;
  /** Lock-screen subtitle: project · host. */
  subtitle: string;
  /** Lock-screen body: headline, then the most useful line that fits as text. */
  body: string;
  /** Row headline in the app. Same words as line 1 of the body. */
  headline: string;
  /** iOS notification category, which carries the actions. */
  category: string;
  /** One thread per agent, so stacks group by who sent them. */
  threadId: string;
};

/**
 * What travels sealed in a push: the record plus its lock-screen text,
 * computed once here so the phone's extension applies it verbatim and no
 * client re-derives the words.
 */
export type SealedAgentNotification = AgentNotification & {
  lockScreen: Pick<AgentNotificationCollapse, "title" | "subtitle" | "body" | "category" | "threadId">;
};

export function sealedAgentNotification(n: AgentNotification): SealedAgentNotification {
  const { title, subtitle, body, category, threadId } = collapseAgentNotification(n);
  return { ...n, lockScreen: { title, subtitle, body, category, threadId } };
}

function riskLabel(risk: AgentNotificationRisk): string {
  return risk === "high" ? "High risk" : risk === "medium" ? "Medium risk" : "Low risk";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function agentNotificationHeadline(n: AgentNotification): string {
  switch (n.view) {
    case "turn.approve.command": return "Wants to run a command";
    case "turn.approve.edit": return `Wants to edit ${plural(n.files.length, "file", "files")}`;
    case "turn.approve.tool": return `Wants to use ${n.tool}`;
    case "turn.question.choice": return n.question;
    case "turn.question.open": return n.question;
    case "turn.failed": return `Turn failed: ${n.error}`;
    case "work.done": return `Done: ${n.summary}`;
    case "ask": return "Asked for you";
    case "text": return n.title;
  }
}

function detailLine(n: AgentNotification): string {
  switch (n.view) {
    case "turn.approve.command": return `${n.command} · ${riskLabel(n.risk)}`;
    case "turn.approve.edit": {
      const added = n.files.reduce((sum, f) => sum + f.added, 0);
      const removed = n.files.reduce((sum, f) => sum + f.removed, 0);
      const counts = `+${added} −${removed}`;
      return n.summary ? `${counts} · ${n.summary}` : `${counts} · ${n.files.map((f) => f.path).join(", ")}`;
    }
    case "turn.approve.tool": return n.summary ? `${n.summary} · ${riskLabel(n.risk)}` : riskLabel(n.risk);
    case "turn.question.choice": return n.options.join(" · ");
    case "turn.question.open": return n.context ?? "";
    case "turn.failed": return n.elapsed ? `After ${n.elapsed}. The session is still open.` : "The session is still open.";
    case "work.done": return (n.artifacts ?? []).map((a) => a.meta ? `${a.label} ${a.meta}` : a.label).join(" · ");
    case "ask": return n.note;
    case "text": return n.body ?? "";
  }
}

/** The actions a view offers, in order. The first is the primary one. */
export function agentNotificationActions(n: AgentNotification): AgentNotificationAction[] {
  switch (n.view) {
    case "turn.approve.command":
    case "turn.approve.edit":
    case "turn.approve.tool":
      return ["approve", "deny"];
    case "turn.question.choice":
    case "turn.question.open":
    case "ask":
      return ["reply"];
    case "turn.failed":
      return ["open_chat"];
    case "work.done":
      return (n.artifacts ?? []).some((a) => a.url) ? ["open_link", "open_chat"] : ["open_chat"];
    case "text":
      return [];
  }
}

/** iOS category ids. Registered by the app with their actions. */
export function agentNotificationCategory(n: AgentNotification): string {
  switch (n.view) {
    case "turn.approve.command":
    case "turn.approve.edit":
    case "turn.approve.tool":
      return "scout.approval";
    case "turn.question.choice":
    case "turn.question.open":
    case "ask":
      return "scout.question";
    case "turn.failed":
    case "work.done":
      return "scout.open";
    case "text":
      return "scout.text";
  }
}

export function collapseAgentNotification(n: AgentNotification): AgentNotificationCollapse {
  const headline = agentNotificationHeadline(n);
  const line2 = detailLine(n).trim();
  const where = [n.project, n.host].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
  return {
    title: n.sender.name,
    subtitle: where,
    body: line2 && line2 !== headline ? `${headline}\n${line2}` : headline,
    headline,
    category: agentNotificationCategory(n),
    threadId: `scout.agent.${n.sender.agentId ?? n.sender.name}`,
  };
}

const MAX_TEXT = 600;

function clip(value: string, max = MAX_TEXT): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Bound every free-text field so a sealed record fits inside one APNs push
 * (4 KB, shared with the alert text). Lists are capped too; the app loads the
 * full item when it opens.
 */
export function clampAgentNotification(n: AgentNotification): AgentNotification {
  const base = {
    ...n,
    sender: { ...n.sender, name: clip(n.sender.name, 80) },
    ...(n.project ? { project: clip(n.project, 80) } : {}),
    ...(n.host ? { host: clip(n.host, 80) } : {}),
  };
  switch (base.view) {
    case "turn.approve.command":
      return { ...base, command: clip(base.command, 400), ...(base.why ? { why: clip(base.why, 300) } : {}) };
    case "turn.approve.edit":
      return { ...base, files: base.files.slice(0, 8).map((f) => ({ ...f, path: clip(f.path, 160) })), ...(base.summary ? { summary: clip(base.summary, 300) } : {}) };
    case "turn.approve.tool":
      return { ...base, tool: clip(base.tool, 80), ...(base.summary ? { summary: clip(base.summary, 300) } : {}) };
    case "turn.question.choice":
      return { ...base, question: clip(base.question, 400), options: base.options.slice(0, 6).map((o) => clip(o, 60)), ...(base.context ? { context: clip(base.context, 300) } : {}) };
    case "turn.question.open":
      return { ...base, question: clip(base.question, 400), ...(base.context ? { context: clip(base.context, 300) } : {}) };
    case "turn.failed":
      return { ...base, error: clip(base.error, 200), ...(base.excerpt ? { excerpt: base.excerpt.slice(-4).map((l) => clip(l, 120)) } : {}) };
    case "work.done":
      return { ...base, summary: clip(base.summary, 300), ...(base.artifacts ? { artifacts: base.artifacts.slice(0, 4) } : {}) };
    case "ask":
      return { ...base, note: clip(base.note, 500), ...(base.options ? { options: base.options.slice(0, 6).map((o) => clip(o, 60)) } : {}) };
    case "text":
      return { ...base, title: clip(base.title, 120), ...(base.body ? { body: clip(base.body, 400) } : {}) };
  }
}
