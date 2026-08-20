/**
 * Pure title-bar projections for CenterPaneHeader (SCO-086 / SCO-087b).
 * Free of React so unit tests do not load chrome modules.
 */
import type { Route } from "../../lib/types.ts";
import { primaryAreaForRoute } from "../primary-areas.ts";
import { areaSubNavForRoute } from "../nav-destinations.ts";

/**
 * Which secondary-nav strip the title bar owns for a route. Only Ops remains:
 * route unification collapsed the Chat DM/Channels split onto one conversation
 * route, so Chat has no strip — do not reintroduce a "chat" kind here.
 */
export function secondaryNavKindForRoute(
  route: Route,
): "ops" | null {
  const areaId = primaryAreaForRoute(route);
  if (areaId === "ops") return "ops";
  return null;
}

/**
 * SCO-087b: whether the top row gets a SECOND stacked row of content
 * navigation (the area sub-nav for projects/sessions, or the Ops/Chat
 * secondary strip). The title bar itself stays "empty of tabs" — only the
 * breadcrumb + right utilities live in the top title row.
 *
 * The shell consumes this to size the top-row frame + contentTopOffset so the
 * arithmetic stays consistent across the center pane, side rail and inspector.
 * Kept in lock-step with CenterPaneHeader's second-row render.
 */
export function hasSecondaryNavRow(route: Route): boolean {
  return (
    Boolean(areaSubNavForRoute(route)) ||
    secondaryNavKindForRoute(route) !== null
  );
}
