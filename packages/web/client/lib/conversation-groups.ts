/**
 * Chat-rail conversation grouping. DMs and observed directs collapse into one
 * rail section per repo when the server resolved a canonical `repoKey` for
 * the agent's checkout; otherwise grouping falls back to project then name.
 */

import { agentStateRank, normalizeAgentState, type AgentDisplayState } from "./agent-state.ts";
import { conversationDisplayTitle, isGroupConversation } from "./conversations.ts";
import { isUnread, type LastViewedMap } from "./sessionRead.ts";
import type { Agent, MessagesSort, SessionEntry } from "./types.ts";

export type ConversationGroup = {
  key: string;
  label: string;
  isChannel: boolean;
  conversations: SessionEntry[];
  bestState: AgentDisplayState;
  latestUpdate: number;
  unreadCount: number;
  canonicalRoot: string | null;
};

export type RepoGroupMember = {
  project: string | null;
  projectRoot: string | null;
  lastActivityAt: number;
};

export function repoNameFromKey(repoKey: string): string {
  const segments = repoKey.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? repoKey;
}

export function pathBasename(path: string): string {
  const segments = path.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] ?? path;
}

export function resolveRepoGroupIdentity(
  members: RepoGroupMember[],
  repoKey: string,
): { label: string; canonicalRoot: string | null } {
  const repoName = repoNameFromKey(repoKey).toLowerCase();
  const rooted = members.filter(
    (member): member is RepoGroupMember & { projectRoot: string } => Boolean(member.projectRoot),
  );
  const matching = rooted.filter(
    (member) => pathBasename(member.projectRoot).toLowerCase() === repoName,
  );
  const pool = matching.length > 0 ? matching : rooted;
  const canonicalRoot = mostCommonRoot(pool);
  if (!canonicalRoot) return { label: repoNameFromKey(repoKey), canonicalRoot: null };
  const labelSource = matching.length > 0
    ? pool.find((member) => member.projectRoot === canonicalRoot)
    : [...pool].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  return { label: labelSource?.project ?? repoNameFromKey(repoKey), canonicalRoot };
}

function mostCommonRoot(members: Array<RepoGroupMember & { projectRoot: string }>): string | null {
  const byRoot = new Map<string, { count: number; latest: number }>();
  for (const member of members) {
    const entry = byRoot.get(member.projectRoot) ?? { count: 0, latest: 0 };
    entry.count += 1;
    entry.latest = Math.max(entry.latest, member.lastActivityAt);
    byRoot.set(member.projectRoot, entry);
  }
  let best: string | null = null;
  let bestCount = -1;
  let bestLatest = -1;
  for (const [root, entry] of byRoot) {
    if (entry.count > bestCount || (entry.count === bestCount && entry.latest > bestLatest)) {
      best = root;
      bestCount = entry.count;
      bestLatest = entry.latest;
    }
  }
  return best;
}

export function buildConversationGroups(
  sessions: SessionEntry[],
  agentById: Map<string, Agent>,
  lastViewed: LastViewedMap,
  sort: MessagesSort,
): ConversationGroup[] {
  const buckets = new Map<string, ConversationGroup>();
  for (const session of sessions) {
    const channel = isGroupConversation(session);
    const agent = session.agentId ? agentById.get(session.agentId) : undefined;
    const repoKey = agent?.repoKey ?? null;
    const project = agent?.project ?? null;
    const groupName = (session.agentName ?? conversationDisplayTitle(session)).trim();
    const key = channel ? `channel:${session.id}`
      : repoKey ? `repo:${repoKey.toLowerCase()}`
      : project ? `project:${project.toLowerCase()}`
      : groupName ? `name:${groupName.toLowerCase()}`
      : `dm:${session.id}`;
    const label = channel ? conversationDisplayTitle(session)
      : repoKey ? repoNameFromKey(repoKey)
      : project ?? groupName ?? conversationDisplayTitle(session);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key, label, isChannel: channel, conversations: [], bestState: "blocked",
        latestUpdate: 0, unreadCount: 0, canonicalRoot: null,
      };
      buckets.set(key, bucket);
    }
    bucket.conversations.push(session);
    bucket.latestUpdate = Math.max(bucket.latestUpdate, session.lastMessageAt ?? 0);
    if (isUnread(session.lastMessageAt, session.id, lastViewed)) bucket.unreadCount += 1;
    if (!channel && agent) {
      const state = normalizeAgentState(agent.state);
      if (agentStateRank(state) < agentStateRank(bucket.bestState)) bucket.bestState = state;
    }
  }

  for (const bucket of buckets.values()) {
    if (bucket.key.startsWith("repo:")) {
      const members = bucket.conversations.map((session) => {
        const agent = session.agentId ? agentById.get(session.agentId) : undefined;
        return { project: agent?.project ?? null, projectRoot: agent?.projectRoot ?? null, lastActivityAt: session.lastMessageAt ?? 0 };
      });
      const identity = resolveRepoGroupIdentity(members, bucket.key.slice("repo:".length));
      bucket.label = identity.label;
      bucket.canonicalRoot = identity.canonicalRoot;
    }
    bucket.conversations.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }

  const list = Array.from(buckets.values());
  if (sort === "name") list.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  else if (sort === "unread") list.sort((a, b) => {
    if ((a.unreadCount > 0) !== (b.unreadCount > 0)) return a.unreadCount > 0 ? -1 : 1;
    return b.latestUpdate - a.latestUpdate;
  });
  else list.sort((a, b) => b.latestUpdate - a.latestUpdate);
  return list;
}
