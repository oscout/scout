import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { AgentInfoScreen } from "./AgentInfoScreen.tsx";
import { AgentsScreen } from "./AgentsScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function AgentsContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view === "agent-info") {
    return (
      <AgentInfoScreen
        conversationId={route.conversationId}
        navigate={navigate}
      />
    );
  }
  if (route.view === "agents-v2") {
    return (
      <AgentsScreen
        navigate={navigate}
        selectedAgentId={route.agentId}
        conversationId={route.conversationId}
        tab={route.tab}
        activeRoute={route}
      />
    );
  }
  return null;
}
