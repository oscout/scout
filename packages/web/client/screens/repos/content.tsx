import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { RepoDiffPageScreen } from "./RepoDiffPageScreen.tsx";
import { ReposScreen } from "./ReposScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function ReposContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view === "repo-diff") {
    return (
      <RepoDiffPageScreen
        path={route.path}
        layers={route.layers}
        files={route.files}
        sessionId={route.sessionId}
        agentId={route.agentId}
        include={route.include}
        navigate={navigate}
      />
    );
  }
  if (route.view === "repos") {
    return <ReposScreen navigate={navigate} focusRoot={route.root ?? null} />;
  }
  return null;
}
