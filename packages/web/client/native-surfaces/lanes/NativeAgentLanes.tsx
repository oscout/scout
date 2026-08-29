import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AgentLanesView,
  type AgentLanesData,
} from "../../screens/ops/AgentLanesView.tsx";
import {
  ScoutContext,
  type ScoutContextValue,
} from "../../scout/Provider.tsx";
import { SCOUT_DEFAULT_APPEARANCE_DETAILS } from "../../lib/theme.ts";
import type { NativeScoutSurfaceClient } from "../../surface-contract/native-scout-surface-client.ts";
import type {
  HostScope,
  SurfaceBootstrap,
} from "../../surface-contract/scout-surface-contract.ts";
import {
  buildNativeLaneSnapshot,
  emptyNativeLaneSnapshot,
  type NativeLaneSnapshot,
} from "./native-agent-lanes-data.ts";

const REFRESH_INTERVAL_MS = 15_000;
const MAX_OBSERVED_AGENTS = 96;
const noOp = () => {};
const noOpAsync = async () => {};

type NativeAgentLanesProps = {
  bootstrap: Partial<SurfaceBootstrap>;
  client: NativeScoutSurfaceClient;
};

export function NativeAgentLanes({ bootstrap, client }: NativeAgentLanesProps) {
  const scopeKey = (bootstrap.selectedHostIds ?? []).join("\0");
  const scope = useMemo<HostScope | null>(() => {
    const hostIds = (bootstrap.selectedHostIds ?? []).filter(Boolean);
    return hostIds.length > 0
      ? { hostIds: hostIds as [string, ...string[]] }
      : null;
  }, [scopeKey]);
  const [snapshot, setSnapshot] = useState<NativeLaneSnapshot>(() => emptyNativeLaneSnapshot());
  const [loading, setLoading] = useState(true);
  // Two different facts, kept apart on purpose. `poll` is how the most recent
  // attempt went; `loaded` is whether the channel has ever answered. A refresh
  // that fails on top of a good snapshot is a blip, not an outage, and the lane
  // deck renders the two very differently — see TailFeedLoadState.
  const [poll, setPoll] = useState({ agents: false, tail: false });
  const [loaded, setLoaded] = useState({ agents: false, tail: false });

  const refresh = useCallback(async (showLoading = false) => {
    if (!scope) return;
    if (showLoading) setLoading(true);
    const [agentResult, tailResult] = await Promise.allSettled([
      client.agents.list(scope),
      client.tail.recent(scope),
    ]);
    const agents = agentResult.status === "fulfilled" ? agentResult.value : null;
    const tail = tailResult.status === "fulfilled" ? tailResult.value : null;
    const tailedAgentIds = new Set(tail?.hosts.flatMap((outcome) => (
      outcome.ready
        ? outcome.value.events.flatMap((event) => event.agentId ? [event.agentId] : [])
        : []
    )) ?? []);
    const observedAgentIds = (agents?.hosts.flatMap((outcome) => (
      outcome.ready
        ? outcome.value.agents
          .filter((agent) => tailedAgentIds.has(agent.id))
          .map((agent) => agent.id)
        : []
    )) ?? []).slice(0, MAX_OBSERVED_AGENTS);
    const observe = bootstrap.capabilities?.includes("agents.observe") && observedAgentIds.length > 0
      ? await client.agents.observe(scope, [...new Set(observedAgentIds)]).catch(() => null)
      : null;
    const next = buildNativeLaneSnapshot(agents, tail, observe, bootstrap);
    setPoll({ agents: next.agentReady, tail: next.tailReady });
    setLoaded((previous) => (
      (next.agentReady && !previous.agents) || (next.tailReady && !previous.tail)
        ? { agents: previous.agents || next.agentReady, tail: previous.tail || next.tailReady }
        : previous
    ));
    // Keep the last good snapshot when a poll fails. Replacing it with the
    // empty one would blank the deck every time a host blinks, on a 15s timer.
    setSnapshot((previous) => (
      !next.agentReady && !next.tailReady && (previous.agentReady || previous.tailReady)
        ? previous
        : next
    ));
    setLoading(false);
  }, [bootstrap, client, scope]);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled && document.visibilityState !== "hidden") void refresh();
    };
    void refresh(true);
    const timer = window.setInterval(tick, REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, scope]);

  const data = useMemo<AgentLanesData>(() => ({
    agents: snapshot.agents,
    discovery: snapshot.discovery,
    tailEvents: snapshot.tailEvents,
    observeCache: snapshot.observeCache,
    terminalSessions: [],
    loadState: {
      discovery: loading ? "loading" : poll.agents ? "ready" : "error",
      recent: loading ? "loading" : poll.tail ? "ready" : "error",
      discoveryLoaded: loaded.agents,
      recentLoaded: loaded.tail,
    },
    retryInitialLoad: () => refresh(true),
  }), [loaded, loading, poll, refresh, snapshot]);

  // AgentLanesView is adapter-backed, but some of its canonical descendants
  // (file links, detail sheets, session headers) consume ScoutContext for UI
  // actions. Supply that presentation context without mounting ScoutProvider,
  // whose browser fetch/SSE lifecycle must stay disabled in a local iOS page.
  const scoutContext = useMemo<ScoutContextValue>(() => ({
    route: { view: "ops", mode: "lanes" },
    navigate: noOp,
    navigateBack: noOp,
    canNavigateBack: false,
    agents: snapshot.agents,
    agentsLoaded: !loading,
    onlineCount: snapshot.agents.length,
    apiConnection: {
      status: "online",
      message: null,
      lastCheckedAt: Date.now(),
    },
    appearanceDetails: SCOUT_DEFAULT_APPEARANCE_DETAILS,
    updateAppearanceDetails: noOp,
    reload: () => refresh(true),
    onboarding: null,
    operatorName: null,
    refreshOnboarding: noOpAsync,
    onboardingSkipped: false,
    skipOnboarding: noOp,
    settingsOpen: false,
    openSettings: noOp,
    closeSettings: noOp,
    scoutbotAgentId: "scoutbot",
    scoutbotConversationId: null,
    applyScoutbotUiAction: noOp,
    selectedBrokerAttempt: null,
    inspectBrokerAttempt: noOp,
    clearBrokerAttempt: noOp,
    selectedKnowledgeHit: null,
    selectedKnowledgeQuery: "",
    inspectKnowledgeHit: noOp,
    clearKnowledgeHit: noOp,
    focusedSession: null,
    focusSession: noOp,
    openFilePreview: noOp,
    closeFilePreview: noOp,
    openContextCapture: noOp,
    closeContextCapture: noOp,
  }), [refresh, snapshot.agents]);

  return (
    <ScoutContext.Provider value={scoutContext}>
      <AgentLanesView
        // Intentionally inert: a bundled file:// page has no browser router.
        // The detail sheet hides its route-jumping buttons in adapter mode.
        navigate={noOp}
        embedded
        profileId="macos.lanes"
        data={data}
      />
    </ScoutContext.Provider>
  );
}
