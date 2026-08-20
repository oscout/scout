import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, peekApiGet } from "../../lib/api.ts";
import { filterAgentsByMachineScope } from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../../lib/surface-activity.ts";
import { useScout } from "../../scout/Provider.tsx";
import { AgentDirectoryStudioInjection } from "../../studio/AgentDirectoryStudioInjection.tsx";
import type {
  AgentTab,
  FleetState,
  HarnessTopologySnapshot,
  Route,
  SessionEntry,
  TailDiscoverySnapshot,
} from "../../lib/types.ts";
import { AgentsSubnav } from "./AgentsSubnav.tsx";
import { AgentsLibrary } from "./library.tsx";
import { directSessionMaps, resolveSelectedAgent } from "./model.ts";
import { AgentDetailWithRail, AgentProfileBar } from "./profile.tsx";
import "./agents-screen.css";
import "../ops/ops-atop.css";
import "../ops/ops-screen.css";

const CONVERSATIONS_PATH = "/api/conversations";
const FLEET_PATH = "/api/fleet";
const DISCOVERY_PATH = "/api/tail/discover";
const TOPOLOGY_PATH = "/api/topology/snapshot?force=1";
const ROUTE_CACHE_MAX_AGE_MS = 30_000;

export function AgentsScreen({
  navigate,
  selectedAgentId,
  conversationId: activeConversationId,
  tab: activeTab,
  activeRoute,
}: {
  navigate: (r: Route) => void;
  selectedAgentId?: string;
  conversationId?: string;
  tab?: AgentTab;
  activeRoute?: Route;
}) {
  const { agents, agentsLoaded, route } = useScout();
  const [sessions, setSessions] = useState<SessionEntry[]>(() =>
    peekApiGet<SessionEntry[]>(CONVERSATIONS_PATH, ROUTE_CACHE_MAX_AGE_MS) ?? [],
  );
  const [fleet, setFleet] = useState<FleetState | null>(() =>
    peekApiGet<FleetState>(FLEET_PATH, ROUTE_CACHE_MAX_AGE_MS),
  );
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(() =>
    peekApiGet<TailDiscoverySnapshot>(DISCOVERY_PATH, ROUTE_CACHE_MAX_AGE_MS),
  );
  const [topologySnapshot, setTopologySnapshot] = useState<HarnessTopologySnapshot | null>(() =>
    peekApiGet<HarnessTopologySnapshot>(TOPOLOGY_PATH, ROUTE_CACHE_MAX_AGE_MS),
  );
  const [loading, setLoading] = useState(() =>
    peekApiGet<SessionEntry[]>(CONVERSATIONS_PATH, ROUTE_CACHE_MAX_AGE_MS) === null,
  );
  const machineId = routeMachineId(route);
  const scopedAgents = useMemo(
    () => filterAgentsByMachineScope(agents, machineId),
    [agents, machineId],
  );

  const load = useCallback(async () => {
    const [sessionsResult, fleetResult, discoveryResult, topologyResult] = await Promise.allSettled([
      api<SessionEntry[]>(CONVERSATIONS_PATH),
      api<FleetState>(FLEET_PATH),
      api<TailDiscoverySnapshot>(DISCOVERY_PATH),
      api<HarnessTopologySnapshot>(TOPOLOGY_PATH),
    ]);
    if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
    if (fleetResult.status === "fulfilled") setFleet(fleetResult.value);
    if (discoveryResult.status === "fulfilled") setDiscovery(discoveryResult.value);
    if (topologyResult.status === "fulfilled") setTopologySnapshot(topologyResult.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const refreshIfActive = () => {
      if (isScoutSurfaceActive()) void load();
    };
    const id = window.setInterval(refreshIfActive, 10_000);
    const stopActivationListener = onScoutSurfaceActivated(refreshIfActive);
    return () => {
      window.clearInterval(id);
      stopActivationListener();
    };
  }, [load]);
  useBrokerEvents(() => {
    if (isScoutSurfaceActive()) void load();
  });

  const selectedAgent = resolveSelectedAgent(scopedAgents, selectedAgentId);
  const selectedAgentWasAliased = Boolean(
    selectedAgentId && selectedAgent && selectedAgent.id !== selectedAgentId,
  );

  // Directory-selection (master-detail): the project is still the route's
  // primary object (projectSlug) and no tab is engaged, so the center stays the
  // directory even with an agent picked — that agent only drives the REAL right
  // inspector. A tab (profile/message/observe) means the agent owns the center.
  const routeProjectSlug = route.view === "agents-v2" ? route.projectSlug : undefined;
  const directorySelection = Boolean(routeProjectSlug && !activeTab);

  const { conversationByAgentId, sessionByAgentId } =
    directSessionMaps(sessions);

  useEffect(() => {
    if (!selectedAgentId || !selectedAgent || !selectedAgentWasAliased) return;
    navigate({
      view: "agents-v2",
      agentId: selectedAgent.id,
      // Preserve the directory-selection route through the alias rewrite so the
      // master-detail stays put instead of jumping to the full profile.
      ...(directorySelection && routeProjectSlug ? { projectSlug: routeProjectSlug } : {}),
      ...(activeConversationId ? { conversationId: activeConversationId } : {}),
      ...(activeTab ? { tab: activeTab } : {}),
    });
  }, [activeConversationId, activeTab, directorySelection, navigate, routeProjectSlug, selectedAgent, selectedAgentId, selectedAgentWasAliased]);

  if (selectedAgent && !directorySelection) {
    const resolvedConversationId =
      activeConversationId
      ?? conversationByAgentId.get(selectedAgent.id)
      ?? selectedAgent.conversationId
      ?? null;
    const resolvedTab = activeTab
      ?? (activeConversationId ? "message" : "profile");
    return (
      <AgentsRouteFrame
        activeRoute={activeRoute ?? route}
        navigate={navigate}
        bar={
          <AgentProfileBar
            agent={selectedAgent}
            conversationId={resolvedConversationId}
            activeTab={resolvedTab}
            navigate={navigate}
          />
        }
      >
        <AgentDetailWithRail
          agent={selectedAgent}
          allAgents={scopedAgents}
          conversationId={resolvedConversationId}
          navigate={navigate}
          activeTab={resolvedTab}
        />
      </AgentsRouteFrame>
    );
  }

  return (
    <AgentsRouteFrame activeRoute={activeRoute ?? route} navigate={navigate}>
      <AgentDirectoryStudioInjection>
        <AgentsLibrary
          agents={scopedAgents}
          fleet={fleet}
          sessionByAgentId={sessionByAgentId}
          conversationByAgentId={conversationByAgentId}
          sessions={sessions}
          discovery={discovery}
          topologySnapshot={topologySnapshot}
          loading={!agentsLoaded || loading}
          navigate={navigate}
          selectedAgentId={selectedAgent?.id ?? selectedAgentId}
        />
      </AgentDirectoryStudioInjection>
    </AgentsRouteFrame>
  );
}

function AgentsRouteFrame({
  activeRoute,
  children,
  navigate,
  bar,
}: {
  activeRoute: Route;
  children: ReactNode;
  navigate: (r: Route) => void;
  bar?: ReactNode;
}) {
  return (
    <div className="s-secondary-nav-shell">
      <div className="s-secondary-nav-bar">
        {bar ?? <AgentsSubnav activeRoute={activeRoute} navigate={navigate} />}
      </div>
      <div className="s-secondary-nav-body">{children}</div>
    </div>
  );
}
