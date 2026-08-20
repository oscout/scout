import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { WorkDetailScreen } from "./WorkDetailScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function WorkContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "work") return null;
  return <WorkDetailScreen workId={route.workId} navigate={navigate} />;
}
