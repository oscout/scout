/**
 * Agent needs-attention index.
 *
 * Joins the two surviving "the operator's move" sources to fleet agent ids so
 * /api/agents can report that an agent is waiting on the human:
 *
 *  - session attention (question / approval / blocked-status items projected
 *    from pairing session snapshots), joined via the agent endpoint's session id
 *  - collaboration records whose next move belongs to the operator, joined via
 *    the record's owning agent
 *
 * The unblock-request pipe that used to carry this state was removed in #287
 * ("Remove unblock request flow"); this index re-sources it from what remains.
 */

import type { SessionAttentionItem } from "@openscout/runtime";

import type { WebAgent } from "../../db/types/web.ts";

export type AgentAttentionEntry = {
  /** The question / approval / handoff text the operator is being asked about. */
  ask: string | null;
  updatedAt: number;
};

export type AgentAttentionCollaborationRow = {
  agentId: string | null;
  title: string;
  summary: string | null;
  updatedAt: number;
};

export type AgentAttentionHostRow = {
  agentId: string;
  summary: string;
  updatedAt: number;
};

/** Kinds that mean "blocked on the operator" — failed turns/actions and
 *  session errors are diagnostics, not requests, and must not flip agents
 *  into needs_attention on every transient failure. */
const BLOCKING_SESSION_ATTENTION_KINDS = new Set<SessionAttentionItem["kind"]>([
  "question",
  "approval",
  "native_attention",
]);

/** Notification banners and HUD rows render one line; collaboration-record
 *  summaries can be long status blobs. */
const MAX_ASK_LENGTH = 200;

function clampAsk(text: string | null): string | null {
  if (!text) {
    return null;
  }
  return text.length > MAX_ASK_LENGTH ? `${text.slice(0, MAX_ASK_LENGTH - 1).trimEnd()}…` : text;
}

function sessionAttentionAsk(item: SessionAttentionItem): string | null {
  if (item.kind === "approval") {
    // Approval titles name the action ("Run terminal command"); the summary
    // carries the command / description. Both together read as the ask.
    return clampAsk([item.title.trim(), item.summary?.trim()].filter(Boolean).join(" — ") || null);
  }
  return clampAsk(item.summary?.trim() || item.title.trim() || null);
}

export function buildAgentAttentionIndex(input: {
  sessionItems: readonly SessionAttentionItem[];
  agentIdBySessionId: ReadonlyMap<string, string>;
  collaborationRows: readonly AgentAttentionCollaborationRow[];
  hostRows?: readonly AgentAttentionHostRow[];
}): Map<string, AgentAttentionEntry> {
  const index = new Map<string, AgentAttentionEntry>();
  const consider = (agentId: string | null | undefined, entry: AgentAttentionEntry) => {
    if (!agentId) {
      return;
    }
    // An entry with no ask must never enter the index. Every source here can
    // produce one — a collaboration record whose title and summary are both
    // blank, a question item that arrived before its text was written — and
    // `applyAgentAttention` would flip the agent to needs_attention anyway,
    // shipping the operator an alert with nothing in it: a card that names no
    // question, and a conversation with no message behind it.
    //
    // Two failures, not one. The obvious one is the contentless alert. The
    // worse one is that `consider` keeps whichever entry is NEWEST, so a blank
    // row arriving after a real question would evict the real question and
    // blank out an ask the operator still owes an answer to. Refusing the
    // entry at the door fixes both.
    if (!entry.ask?.trim()) {
      return;
    }
    const existing = index.get(agentId);
    if (!existing || entry.updatedAt > existing.updatedAt) {
      index.set(agentId, entry);
    }
  };

  for (const item of input.sessionItems) {
    if (!BLOCKING_SESSION_ATTENTION_KINDS.has(item.kind)) {
      continue;
    }
    consider(input.agentIdBySessionId.get(item.sessionId), {
      ask: sessionAttentionAsk(item),
      updatedAt: item.updatedAt,
    });
  }

  for (const row of input.collaborationRows) {
    consider(row.agentId, {
      ask: clampAsk(row.summary?.trim() || row.title.trim() || null),
      updatedAt: row.updatedAt,
    });
  }

  for (const row of input.hostRows ?? []) {
    consider(row.agentId, {
      ask: clampAsk(row.summary.trim() || null),
      updatedAt: row.updatedAt,
    });
  }

  return index;
}

/**
 * Attention outranks working/in_flight: from the operator's seat, an agent
 * with a pending ask "needs you" even if its flight is still moving. Clients
 * debounce and baseline on their side (ScoutAttentionTracker), so flapping
 * here does not ambush anyone.
 */
export function applyAgentAttention(
  agents: WebAgent[],
  index: ReadonlyMap<string, AgentAttentionEntry>,
): WebAgent[] {
  if (index.size === 0) {
    return agents;
  }
  return agents.map((agent) => {
    const entry = index.get(agent.id);
    if (!entry) {
      return agent;
    }
    return { ...agent, state: "needs_attention", pendingAsk: entry.ask };
  });
}
