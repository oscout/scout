import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { HarnessesScreen } from "./HarnessesScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function HarnessesContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "harnesses") return null;
  return <HarnessesScreen navigate={navigate} />;
}
