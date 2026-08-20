import { useEffect, useMemo, useRef, useState } from "react";

import { useTailFeed } from "../../lib/use-tail-feed.ts";
import { useObservePolling } from "../../lib/observe.ts";
import { fetchTerminalSessions } from "../../lib/terminal-sessions.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../../lib/surface-activity.ts";
import type { Agent } from "../../lib/types.ts";
import type { TerminalSessionRecord } from "@openscout/protocol";
import {
  AGENT_LANE_HORIZON_OPTIONS,
  agentLaneHorizonLabel,
  agentLaneHorizonWindowMs,
  agentLaneTailRecentLimit,
  buildAgentLanes,
  createStableLaneOrder,
  DEFAULT_AGENT_LANE_HORIZON,
  rosterIssuesFromTailDiscovery,
  shouldPollAgentForLaneObserve,
  sortLanesWithStableOrder,
  type AgentLane,
  type AgentLaneHorizonKey,
  type AgentLaneRosterIssue,
} from "../../screens/ops/agent-lanes-model.ts";
import type { AgentLaneWidthTier } from "../../screens/ops/lane-deck.ts";
import { SCOPE_LANE_DECK_PROFILE } from "../lane-deck.ts";
import { useScopeLaneDeck } from "../useScopeLaneDeck.ts";
import { scopeStorageKey } from "../../../shared/scope-integration.js";

const LANE_HORIZON_STORAGE_KEY = scopeStorageKey("lanes-horizon");

function readStoredHorizon(): AgentLaneHorizonKey {
  try {
    const stored = sessionStorage.getItem(LANE_HORIZON_STORAGE_KEY);
    if (stored && AGENT_LANE_HORIZON_OPTIONS.some((option) => option.key === stored)) {
      return stored as AgentLaneHorizonKey;
    }
  } catch {
    // ignore storage failures
  }
  return DEFAULT_AGENT_LANE_HORIZON;
}

export type AgentLanesEmbedFilters = {
  harnessFilter?: string | null;
  projectFilter?: string | null;
};

export function useAgentLanesData({
  scoutAgents,
  defaultWidthTier = "md",
  harnessFilter,
  projectFilter,
  horizonOverride,
}: {
  scoutAgents: Agent[];
  defaultWidthTier?: AgentLaneWidthTier;
  harnessFilter?: string | null;
  projectFilter?: string | null;
  /** Pin the admission window (e.g. floor layout) without touching the stored choice. */
  horizonOverride?: AgentLaneHorizonKey;
}) {
  const [now, setNow] = useState(Date.now());
  const [storedHorizon, setHorizon] = useState<AgentLaneHorizonKey>(readStoredHorizon);
  const horizon = horizonOverride ?? storedHorizon;
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionRecord[]>([]);
  const [newLaneIds, setNewLaneIds] = useState<Set<string>>(() => new Set());

  const tailRecentLimit = agentLaneTailRecentLimit(horizon);
  const traceWindowMs = agentLaneHorizonWindowMs(horizon);
  const horizonLabel = agentLaneHorizonLabel(horizon);

  const { discovery, events: tailEvents, loadState } = useTailFeed({
    includeTranscriptReplay: true,
    discoveryIntervalMs: 5_000,
    recentLimit: tailRecentLimit,
    pauseWhenHidden: true,
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!isScoutSurfaceActive()) return;
      try {
        const sessions = await fetchTerminalSessions({ includeDiscovered: false });
        if (!cancelled) setTerminalSessions(sessions);
      } catch {
        if (!cancelled) setTerminalSessions([]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    const stopActivationListener = onScoutSurfaceActivated(() => void load());
    return () => {
      cancelled = true;
      clearInterval(timer);
      stopActivationListener();
    };
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(LANE_HORIZON_STORAGE_KEY, storedHorizon);
    } catch {
      // ignore storage failures
    }
  }, [storedHorizon]);

  const laneOrderRef = useRef(createStableLaneOrder());
  const observeAgents = useMemo(
    () => scoutAgents.filter((agent) => shouldPollAgentForLaneObserve(agent, now, horizon)),
    [scoutAgents, now, horizon],
  );
  const observeCache = useObservePolling(observeAgents, { pauseWhenHidden: true });
  const tailLoading = loadState.discovery === "loading" || loadState.recent === "loading";

  useEffect(() => {
    if (newLaneIds.size === 0) return;
    const timer = setTimeout(() => setNewLaneIds(new Set()), 900);
    return () => clearTimeout(timer);
  }, [newLaneIds]);

  const { lanes, issues, freshLaneIds } = useMemo(() => {
    const built = buildAgentLanes({
      transcripts: discovery?.transcripts ?? [],
      tailEvents,
      processes: discovery?.processes ?? [],
      scoutAgents,
      terminalSessions,
      observeCache,
      now,
      workingOnly: true,
      horizon,
    });
    const result = sortLanesWithStableOrder(built.lanes, laneOrderRef.current);
    const rosterIssues: AgentLaneRosterIssue[] = [
      ...rosterIssuesFromTailDiscovery(discovery),
      ...built.issues,
    ];
    return {
      lanes: result.lanes,
      issues: rosterIssues,
      freshLaneIds: result.newLaneIds,
    };
  }, [discovery, tailEvents, scoutAgents, terminalSessions, observeCache, now, horizon]);

  useEffect(() => {
    if (issues.length === 0) return;
    for (const issue of issues) {
      console.warn(`[agent-lanes] ${issue.message}`, issue);
    }
  }, [issues]);

  useEffect(() => {
    if (freshLaneIds.length === 0) return;
    setNewLaneIds((previous) => {
      const next = new Set(previous);
      for (const id of freshLaneIds) next.add(id);
      return next;
    });
  }, [freshLaneIds.join("\0")]);

  const filteredLanes = useMemo(
    () => lanes.filter((lane) => laneMatchesEmbedFilters(lane, { harnessFilter, projectFilter })),
    [lanes, harnessFilter, projectFilter],
  );

  const {
    deck,
    layout,
    setLaneWidth,
    setDefaultLaneWidth,
  } = useScopeLaneDeck(defaultWidthTier, filteredLanes);

  return {
    profileId: SCOPE_LANE_DECK_PROFILE,
    now,
    horizon,
    setHorizon,
    horizonLabel,
    traceWindowMs,
    lanes: filteredLanes,
    issues,
    newLaneIds,
    tailLoading,
    deck,
    layout,
    setLaneWidth,
    setDefaultLaneWidth,
    activeFilterLabel: embedFilterLabel({ harnessFilter, projectFilter }),
  };
}

function normalizeEmbedFilter(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function pathLeaf(value: string): string | null {
  const leaf = value.trim().replace(/\/+$/u, "").split(/[\\/]/u).filter(Boolean).pop();
  return leaf?.trim() || null;
}

function matchesAnyFilter(candidates: Array<string | null | undefined>, filter: string | null): boolean {
  if (!filter) return true;
  const filterSlug = slugValue(filter);
  return candidates.some((candidate) => {
    const raw = candidate?.trim();
    if (!raw) return false;
    const normalized = raw.toLowerCase();
    const leaf = pathLeaf(raw);
    return normalized === filter
      || slugValue(raw) === filterSlug
      || Boolean(leaf && (leaf.toLowerCase() === filter || slugValue(leaf) === filterSlug));
  });
}

function laneMatchesEmbedFilters(lane: AgentLane, filters: AgentLanesEmbedFilters): boolean {
  const harnessFilter = normalizeEmbedFilter(filters.harnessFilter);
  const projectFilter = normalizeEmbedFilter(filters.projectFilter);
  const { agent, facts, source } = lane;
  return matchesAnyFilter(
    [agent.harness, agent.definitionId, facts?.attribution, source],
    harnessFilter,
  ) && matchesAnyFilter(
    [agent.project, agent.projectRoot, agent.cwd, facts?.cwd],
    projectFilter,
  );
}

function embedFilterLabel(filters: AgentLanesEmbedFilters): string {
  const parts = [
    filters.harnessFilter?.trim() ? `harness ${filters.harnessFilter.trim()}` : "",
    filters.projectFilter?.trim() ? `project ${filters.projectFilter.trim()}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}
