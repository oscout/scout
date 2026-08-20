import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { filterAgentsByMachineScope } from "../../lib/machine-scope.ts";
import { routeMachineId } from "../../lib/router.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { useScout } from "../../scout/Provider.tsx";
import type { AgentTab, Route, SessionEntry } from "../../lib/types.ts";
import { AgentsSubnav } from "../agents/AgentsSubnav.tsx";
import { AgentDetailWithRail, AgentProfileSessionsCenter } from "../agents/profile.tsx";
import { agentLabel, directSessionMaps, resolveSelectedAgent } from "../agents/model.ts";
import "../agents/agents-screen.css";
import "../ops/ops-atop.css";
import "../ops/ops-screen.css";
import { ProjectAgentProfileBar } from "./ProjectAgentProfileBar.tsx";
import "./projects.css";

export function ProjectAgentProfile({
  route,
  navigate,
}: {
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: (route: Route) => void;
}) {
  const { agents } = useScout();
  const machineId = routeMachineId(route);
  const scopedAgents = useMemo(
    () => filterAgentsByMachineScope(agents, machineId),
    [agents, machineId],
  );
  const [sessions, setSessions] = useState<SessionEntry[]>([]);

  const load = useCallback(async () => {
    const result = await api<SessionEntry[]>("/api/conversations").catch(() => []);
    setSessions(result);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  const selectedAgent = resolveSelectedAgent(scopedAgents, route.agentId);
  const selectedAgentWasAliased = Boolean(
    route.agentId && selectedAgent && selectedAgent.id !== route.agentId,
  );

  const { conversationByAgentId } = directSessionMaps(sessions);

  useEffect(() => {
    if (!route.agentId || !selectedAgent || !selectedAgentWasAliased) return;
    navigate({
      ...route,
      view: "agents-v2",
      agentId: selectedAgent.id,
    });
  }, [navigate, route, selectedAgent, route.agentId, selectedAgentWasAliased]);

  if (!selectedAgent) {
    return (
      <ProjectRouteFrame activeRoute={route} navigate={navigate}>
        <div className="av2-empty">Agent not found.</div>
      </ProjectRouteFrame>
    );
  }

  const resolvedConversationId =
    route.conversationId
    ?? conversationByAgentId.get(selectedAgent.id)
    ?? selectedAgent.conversationId
    ?? null;
  const resolvedTab: AgentTab =
    route.tab ?? (route.conversationId ? "message" : "profile");

  return (
    <div className="s-av2-profileShell">
      <ProjectRouteFrame
        activeRoute={route}
        navigate={navigate}
        bar={
          <ProjectAgentProfileBar
            agent={selectedAgent}
            conversationId={resolvedConversationId}
            activeTab={resolvedTab}
            route={route}
            navigate={navigate}
          />
        }
      >
        <div className="av2-profileCanvas">
          <AgentDetailWithRail
            agent={selectedAgent}
            allAgents={scopedAgents}
            conversationId={resolvedConversationId}
            navigate={navigate}
            activeTab={resolvedTab}
            renderProfile={({ agent, sessionCatalog, conversationId, navigate, route }) => (
              <AgentProfileSessionsCenter
                agent={agent}
                name={agentLabel(agent, scopedAgents).name}
                sessionCatalog={sessionCatalog}
                conversationId={conversationId}
                navigate={navigate}
                route={route}
                homeView="agents-v2"
              />
            )}
          />
        </div>
      </ProjectRouteFrame>
    </div>
  );
}

function ProjectRouteFrame({
  activeRoute,
  children,
  navigate,
  bar,
}: {
  activeRoute: Route;
  children: ReactNode;
  navigate: (route: Route) => void;
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
