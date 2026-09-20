import "./ops-screen.css";

import { useScout } from "../../scout/Provider.tsx";
import { PageStatusBar } from "../../components/PageStatusBar.tsx";
import { AgentLanesView } from "./AgentLanesView.tsx";
import { MissionControlView } from "./MissionControlView.tsx";
import { OpsAgentsView } from "./OpsAgentsView.tsx";
import { HostAdvisorView } from "./HostAdvisorView.tsx";
import { AtopView } from "./AtopView.tsx";
import { TailView } from "../shared/TailView.tsx";
import type { OpsMode, Route } from "../../lib/types.ts";
import { useContentOwnsSecondaryNav } from "../../scout/sidebar/useContentSecondaryNav.ts";
import { OpsSubnav } from "./OpsSubnav.tsx";
import { FleetRollCallHud } from "./FleetRollCallHud.tsx";

export function OpsScreen({
  navigate,
  mode = "mission",
  tailQuery,
  showSecondaryNav,
}: {
  navigate: (r: Route) => void;
  mode?: OpsMode;
  tailQuery?: string;
  showSecondaryNav?: boolean;
}) {
  const { agents, route } = useScout();
  const contentOwnsSecondaryNav = useContentOwnsSecondaryNav();

  return (
    <div className="s-ops">
      {(showSecondaryNav ?? contentOwnsSecondaryNav) ? (
        <div className="s-ops-header">
          <OpsSubnav activeRoute={route} navigate={navigate} />
        </div>
      ) : null}
      <div className="s-ops-body">
        {(mode === "lanes" || mode === "world") && <FleetRollCallHud />}
        {mode === "mission" && <MissionControlView navigate={navigate} agents={agents} />}
        {mode === "agents" && <OpsAgentsView navigate={navigate} agents={agents} />}
        {mode === "advisor" && (
          <HostAdvisorView
            navigate={navigate}
            agents={agents}
          />
        )}
        {mode === "issues" && <TailView navigate={navigate} initialFilter={tailQuery} variant="issues" />}
        {mode === "tail" && (
          <TailView
            navigate={navigate}
            initialFilter={tailQuery}
            variant="tail"
          />
        )}
        {mode === "atop" && <AtopView />}
        {(mode === "lanes" || mode === "world") && <AgentLanesView navigate={navigate} agents={agents} />}
      </div>
      <PageStatusBar />
    </div>
  );
}