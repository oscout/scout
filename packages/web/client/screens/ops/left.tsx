import { useScout } from "../../scout/Provider.tsx";
import { OpsAgentsLeft } from "./left-agents.tsx";
import { OpsDefaultLeft } from "./left-default.tsx";
import { OpsLanesLeft } from "./left-lanes.tsx";
import { OpsMissionLeft } from "./left-mission.tsx";
import { OpsPlanLeft } from "./left-plan.tsx";

export function OpsLeft() {
  const { route } = useScout();
  if (route.view !== "ops") return null;

  switch (route.mode) {
    case "mission":
      return <OpsMissionLeft />;
    case "agents":
      return <OpsAgentsLeft />;
    case "plan":
      return <OpsPlanLeft />;
    case "lanes":
      return <OpsLanesLeft />;
    default:
      return <OpsDefaultLeft />;
  }
}
