import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { BrokerScreen } from "./BrokerScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function BrokerContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "broker") return null;
  return <BrokerScreen navigate={navigate} />;
}
