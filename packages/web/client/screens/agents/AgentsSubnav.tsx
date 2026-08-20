import { SecondaryNav } from "../../components/SecondaryNav.tsx";
import type { Route } from "../../lib/types.ts";
import { AGENTS_SECONDARY_NAV } from "../../scout/secondaryNavConfig.ts";

export function AgentsSubnav({
  activeRoute,
  navigate,
}: {
  activeRoute: Route;
  navigate: (route: Route) => void;
}) {
  return (
    <SecondaryNav
      ariaLabel="Agents sections"
      activeRoute={activeRoute}
      groups={AGENTS_SECONDARY_NAV}
      navigate={navigate}
    />
  );
}
