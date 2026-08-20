import type { Route } from "../../lib/types.ts";
import { SecondaryNav } from "../../components/SecondaryNav.tsx";
import { OPS_SECONDARY_NAV } from "../../scout/secondaryNavConfig.ts";
import "./ops-screen.css";

export function OpsSubnav({
  activeRoute,
  navigate,
}: {
  activeRoute: Route;
  navigate: (route: Route) => void;
}) {
  return (
    <SecondaryNav
      ariaLabel="Ops sections"
      activeRoute={activeRoute}
      groups={OPS_SECONDARY_NAV}
      navigate={navigate}
    />
  );
}
