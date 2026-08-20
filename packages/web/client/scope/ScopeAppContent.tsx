import { useBrowserLocation } from "../lib/router.ts";
import { useScout } from "../scout/Provider.tsx";
import { ScoutSurface } from "../scout/slots/ScoutSurface.tsx";
import { resolveContentPane } from "../screens/resolve-panes.tsx";
import { resolveScopeContentPane } from "./resolve-content.tsx";

/** App content slot — Scope routes render in scope/; Scout routes use screens/. */
export function ScopeAppContent() {
  const { route, navigate, agents } = useScout();
  const { pathname } = useBrowserLocation();
  const scopePane = resolveScopeContentPane(route, navigate, agents, pathname);

  return (
    <ScoutSurface>
      {scopePane ?? resolveContentPane(route, navigate, agents)}
    </ScoutSurface>
  );
}