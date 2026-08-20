import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { MeshScreen } from "./MeshScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function MeshContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "mesh") return null;
  return <MeshScreen navigate={navigate} />;
}
