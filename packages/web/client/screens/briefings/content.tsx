import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { BriefingDetailScreen } from "./BriefingDetailScreen.tsx";
import { BriefingsScreen } from "./BriefingsScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function BriefingsContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "briefings") return null;
  return route.briefingId
    ? <BriefingDetailScreen briefingId={route.briefingId} navigate={navigate} />
    : <BriefingsScreen navigate={navigate} />;
}
