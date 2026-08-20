/**
 * When sidebar chrome owns the Ops secondary strip in CenterPaneHeader
 * (SCO-086), content screens must not re-render it.
 *
 * Legacy `?ff.nav.sidebar=off` path still owns in-content subnav.
 */
import { useOptionalFlag } from "hudsonkit/flags";

/** True when the screen should still render its own OpsSubnav. */
export function useContentOwnsSecondaryNav(): boolean {
  const sidebarChrome = useOptionalFlag("nav.sidebar", false);
  return !sidebarChrome;
}
