import "./ops-screen.css";

import { useScout } from "../../scout/Provider.tsx";
import { PageStatusBar } from "../../components/PageStatusBar.tsx";
import { AgentLanesView } from "./AgentLanesView.tsx";
import { MissionControlView } from "./MissionControlView.tsx";
import { OpsAgentsView } from "./OpsAgentsView.tsx";
import { PlanView } from "./PlanView.tsx";
import { AtopView } from "./AtopView.tsx";
import { TailView } from "../shared/TailView.tsx";
import type { OpsMode, Route } from "../../lib/types.ts";
import { useContentOwnsSecondaryNav } from "../../scout/sidebar/useContentSecondaryNav.ts";
import { OpsSubnav } from "./OpsSubnav.tsx";

export function OpsScreen({
  navigate,
  mode = "mission",
  tailQuery,
}: {
  navigate: (r: Route) => void;
  mode?: OpsMode;
  tailQuery?: string;
}) {
  const { agents, route } = useScout();
  const contentOwnsSecondaryNav = useContentOwnsSecondaryNav();
  const selectedPlanDocumentId = route.view === "ops" && route.mode === "plan"
    ? route.planDocumentId
    : undefined;

  return (
    <div className="s-ops">
      {contentOwnsSecondaryNav ? (
        <div className="s-ops-header">
          <OpsSubnav activeRoute={route} navigate={navigate} />
        </div>
      ) : null}
      <div className="s-ops-body">
        {mode === "mission" && <MissionControlView navigate={navigate} agents={agents} />}
        {mode === "agents" && <OpsAgentsView navigate={navigate} agents={agents} />}
        {mode === "plan" && (
          <PlanView
            navigate={navigate}
            agents={agents}
            selectedPlanDocumentId={selectedPlanDocumentId}
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
        {mode === "lanes" && <AgentLanesView navigate={navigate} agents={agents} />}
      </div>
      <PageStatusBar />
    </div>
  );
}