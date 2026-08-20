import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { FollowScreen } from "./FollowScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function FollowContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "follow") return null;
  return <FollowScreen route={route} navigate={navigate} />;
}
