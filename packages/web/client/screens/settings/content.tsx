import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function SettingsContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "settings") return null;
  return <SettingsScreen navigate={navigate} section={route.section} agentId={route.agentId} />;
}
