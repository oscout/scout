import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { ActivityScreen } from "./ActivityScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function ActivityContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "activity") return null;
  return <ActivityScreen navigate={navigate} />;
}
