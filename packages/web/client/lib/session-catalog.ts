import type {
  Agent,
  SessionCatalogEntry,
  SessionCatalogWithResume,
} from "./types.ts";
import { resolveAgentTerminalSurface } from "./terminal-relay.ts";

// Shared session-catalog selection logic for the agent profile. The center
// (session list) and the rail (session-focused context) are decoupled slots
// that each fetch the catalog independently — they must agree on which session
// is "the one being explored", so they both resolve selection through here.

/** The session the agent is "in" right now — the catalog's active id, or for a
 *  tmux agent its harness session id when the catalog hasn't named one. */
export function resolveActiveSessionId(
  agent: Agent,
  catalog: SessionCatalogWithResume | null,
): string | null {
  const terminalSurface = resolveAgentTerminalSurface(agent);
  const fallbackTerminalSessionId = terminalSurface
    ? agent.harnessSessionId ?? terminalSurface.sessionName
    : null;
  return (
    catalog?.activeSessionId ??
    fallbackTerminalSessionId
  );
}

/** Sessions ordered for the profile spine: the active one first, then by recency
 *  (most recent end/start first). */
export function sortSessionsByRecency(
  sessions: SessionCatalogEntry[],
  activeSessionId: string | null,
): SessionCatalogEntry[] {
  return [...sessions].sort((a, b) => {
    const aActive = a.id === activeSessionId ? 1 : 0;
    const bActive = b.id === activeSessionId ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
  });
}

/** A center session selection, scoped to the agent it was made on so it
 *  auto-invalidates when the focused agent changes. */
export type FocusedSession = { agentId: string; sessionId: string };

type SessionCatalogEntryWithAliases = SessionCatalogEntry & {
  harnessSessionId?: string | null;
  externalSessionId?: string | null;
  threadId?: string | null;
  runtimeSessionId?: string | null;
  runtimeSessionRef?: string | null;
  runtimeRef?: string | null;
  sourceSessionId?: string | null;
  sessionId?: string | null;
  refId?: string | null;
};

function sessionAliasValues(session: SessionCatalogEntry): string[] {
  const candidate = session as SessionCatalogEntryWithAliases;
  return [
    candidate.id,
    candidate.surfaceSessionId,
    candidate.harnessSessionId,
    candidate.externalSessionId,
    candidate.threadId,
    candidate.runtimeSessionId,
    candidate.runtimeSessionRef,
    candidate.runtimeRef,
    candidate.sourceSessionId,
    candidate.sessionId,
    candidate.refId,
  ].flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  });
}

function relayAliasParts(value: string): { scope: string; harness: string } | null {
  const match = /^relay-(.+)-(claude|codex)$/iu.exec(value);
  if (!match) return null;
  return { scope: match[1]!.toLowerCase(), harness: match[2]!.toLowerCase() };
}

function relayAliasMatches(candidate: string, routed: string): boolean {
  const candidateParts = relayAliasParts(candidate);
  const routedParts = relayAliasParts(routed);
  if (!candidateParts || !routedParts) return false;
  return candidateParts.harness === routedParts.harness
    && (
      candidateParts.scope === routedParts.scope
      || candidateParts.scope.startsWith(`${routedParts.scope}-`)
    );
}

export function resolveRoutedSessionId(
  sessionId: string | null | undefined,
  sorted: SessionCatalogEntry[],
): string | null {
  const routed = sessionId?.trim();
  if (!routed) return null;
  const exact = sorted.find((s) => sessionAliasValues(s).some((value) => value === routed));
  if (exact) return exact.id;
  const relayMatches = sorted.filter((s) =>
    sessionAliasValues(s).some((value) => relayAliasMatches(value, routed))
  );
  const uniqueIds = new Set(relayMatches.map((s) => s.id));
  return uniqueIds.size === 1 ? relayMatches[0]?.id ?? null : null;
}

/** The session the profile is exploring: a routed `sessionId` (when it
 *  still belongs to this agent and exists) wins, else the active session, else
 *  the most recent. Routed selection is the single source of truth — there is
 *  no parallel in-memory focus fallback (SCO-082 Phase B).
 *  `sorted` is the output of {@link sortSessionsByRecency}.
 *
 *  The `focusedSession` argument is retained for call-site compatibility but
 *  ignored; pass `null`. */
export function resolveSelectedSessionId(
  _agentId: string,
  _focusedSession: FocusedSession | null,
  activeSessionId: string | null,
  sorted: SessionCatalogEntry[],
  routedSessionId?: string | null,
): string | null {
  const routed = resolveRoutedSessionId(routedSessionId, sorted);
  if (routed) return routed;
  return activeSessionId ?? sorted[0]?.id ?? null;
}

/** Per-session engage capabilities. The catalog flags *enable* a surface; the
 *  transport adds the cases the flags may miss — a terminal surface is always
 *  observable and takeoverable (you grab the live pane; no resume command
 *  needed), and any resume command makes a session takeoverable. We OR these
 *  rather than letting a stale `false` flag veto an attached surface, which
 *  matches what the takeover handler can actually do. Only a live session
 *  qualifies. */
export function sessionEngage(
  agent: Agent,
  catalog: SessionCatalogWithResume | null,
  session: SessionCatalogEntry,
  active: boolean,
): { canObserve: boolean; canTakeover: boolean } {
  const hasTerminalSurface = Boolean(resolveAgentTerminalSurface(agent));
  const canObserve = active && (Boolean(session.canObserve) || hasTerminalSurface);
  const canTakeover =
    active && (Boolean(session.canTakeover) || hasTerminalSurface || Boolean(catalog?.resumeCommand));
  return { canObserve, canTakeover };
}
