import type { Agent, AgentTab, Route } from "../../lib/types.ts";
import { registryRoute } from "./model.ts";

export function ProjectAgentProfileBar({
  agent,
  conversationId,
  activeTab,
  route,
  navigate,
}: {
  agent: Agent;
  conversationId: string | null;
  activeTab: AgentTab;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: (r: Route) => void;
}) {
  const tabs: { key: AgentTab; label: string }[] = [
    { key: "profile", label: "Sessions" },
    { key: "config", label: "Config" },
    { key: "observe", label: "Trace" },
    { key: "message", label: "Message" },
  ];

  const navigateToTab = (tab: AgentTab) =>
    navigate({
      ...route,
      view: "agents-v2",
      agentId: agent.id,
      ...(conversationId ? { conversationId } : {}),
      tab,
    });

  return (
    <div className="av2-profileBar">
      <button
        type="button"
        className="av2-profileBack"
        onClick={() =>
          navigate(registryRoute(route))
        }
      >
        <span className="av2-profileBackGlyph" aria-hidden>←</span>
        Project
      </button>

      <nav className="av2-profileTabs" aria-label="Agent views">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className="av2-profileTab"
            data-on={activeTab === t.key || undefined}
            onClick={() => navigateToTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
