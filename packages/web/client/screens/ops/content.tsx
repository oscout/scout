import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { OpsScreen } from "./OpsScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function OpsContent({
  route,
  navigate,
}: {
  route: Route;
  navigate: Navigate;
}) {
  if (route.view !== "ops") return null;
  return (
    <OpsScreen
      navigate={navigate}
      mode={route.mode}
      tailQuery={route.tailQuery}
    />
  );
}