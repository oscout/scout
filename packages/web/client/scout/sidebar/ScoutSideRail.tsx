/**
 * Scout side rail (SCO-084 / SCO-086) — LEFT HudsonKit SidePanel for per-area context.
 *
 * Distinct shell slot from the shadcn nav sidebar and from the legacy LeftPanel
 * path. Shares the SidePanel component with the right inspector; does not wrap
 * or restyle SidePanel into a sidebar.
 *
 * SCO-086: collapsed state is an OpenScout CollapsedRail at RAIL_COLLAPSED_WIDTH
 * (HudsonKit SidePanel collapses to a 0px floating button — not a rail).
 * Expanded panel omits onToggleCollapse; ONE shared RailToggle is rendered
 * outside both hosts, in the column's 44px header band, in both states.
 *
 * Keep-alive: the expanded SidePanel (and its context body, e.g. ChatLeft) stays
 * mounted while collapsed — only hidden with CSS — so expand does not remount
 * and re-fetch the rail (no loading flash).
 *
 * Content: resolveSidebarContext(route) body (scrollable) + footer pinned at
 * the panel bottom (Mesh rack/map behavior unchanged).
 */
import type { CSSProperties, ReactNode } from "react";
import { SidePanel } from "@hudsonkit/chrome";
import { RailToggle } from "../../components/RailToggle.tsx";
import type { Route } from "../../lib/types.ts";
import { useScout } from "../Provider.tsx";
import { primaryAreaForRoute, PRIMARY_AREAS } from "../primary-areas.ts";
import { resolveSidebarContext } from "../../screens/resolve-sidebar-context.tsx";
import { CollapsedRail } from "./CollapsedRail.tsx";
import {
  RAIL_COLLAPSED_WIDTH,
  RAIL_TOGGLE_HEADER_TOP,
  railToggleOffset,
} from "./sidebar-collapse-state.ts";
import { SideRailCollapsedBody } from "./SideRailCollapsedBody.tsx";
import { useSidebarModel } from "./useSidebarModel.ts";

/**
 * Whether resolveSidebarContext yields body/footer for the current route.
 * Used by the shell for left-inset arithmetic without mounting the rail.
 * Scope presentation has no Scout context pane.
 */
export function sideRailHasContent(route: Route, scopePresentation: boolean): boolean {
  if (scopePresentation) return false;
  // Keep in sync with resolveSidebarContext non-null cases.
  switch (route.view) {
    case "inbox":
    case "activity":
    case "briefings":
    case "agents-v2":
    case "agent-info":
    case "terminal":
    case "messages":
    case "conversation":
    case "ops":
    case "mesh":
    case "mesh-ops":
      return true;
    default:
      return false;
  }
}

export function ScoutSideRail({
  presentation = "scout",
  navRailWidth,
  isCollapsed,
  onToggleCollapse,
  width,
  style,
  hideWhenEmpty = true,
}: {
  presentation?: "scout" | "slack";
  /** Current shadcn sidebar width (48 or expanded) — side rail sits to its right. */
  navRailWidth: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Committed (pinned) side-rail width — the panel box never relayouts per drag frame. */
  width: number;
  style?: CSSProperties;
  /** When true, render nothing if both body and footer are null. */
  hideWhenEmpty?: boolean;
}) {
  const { route, navigate } = useScout();
  const model = useSidebarModel(route);
  const context =
    model.kind === "scope"
      ? { body: null as ReactNode, footer: null as ReactNode }
      : resolveSidebarContext(route, navigate);

  const empty = !context.body && !context.footer;
  if (hideWhenEmpty && empty) return null;

  const areaId = primaryAreaForRoute(route);
  const area = PRIMARY_AREAS.find((a) => a.id === areaId);
  const title = model.kind === "scope"
    ? "Scope"
    : presentation === "slack" && areaId === "chat"
      ? "Scout"
      : presentation === "slack" && areaId === "home"
        ? "Activity"
        : (area?.label ?? "Context");
  const top =
    typeof style?.top === "number"
      ? style.top
      : typeof style?.top === "string"
        ? Number.parseFloat(style.top) || 0
        : 0;

  // SCO-088 §3: the shell owns the ghost-edge resize (handle + ghost line +
  // one-write commit), so the side rail no longer passes onResizeStart to
  // HudsonKit (that drove a live, per-frame width update). SCO-088c (Codex
  // blocker 1): the chevron stays pinned at the committed edge during a drag (the
  // ghost line is the live preview) — no per-frame layout animation.
  //
  // ONE toggle, rendered in both states, in the column's own 44px header band:
  // expanded it tucks against the inner edge, collapsed it centres in the 48px
  // rail. Same band, same y — the control never migrates to the rail foot and
  // never straddles the seam (the seam belongs to resize).
  const railWidth = isCollapsed ? RAIL_COLLAPSED_WIDTH : width;
  const toggleLeft = navRailWidth + railToggleOffset(railWidth, isCollapsed);

  return (
    <>
      {/* Both expanded + collapsed hosts stay mounted. Collapse/expand is a CSS
          visibility swap so neither side cold-mounts or re-fetches. Shell
          insets still use the 48px CollapsedRail width when isCollapsed. */}
      <div
        className="scout-side-rail-expanded-host"
        data-presentation={presentation}
        data-collapsed={isCollapsed ? "true" : "false"}
        hidden={isCollapsed}
        aria-hidden={isCollapsed}
        style={isCollapsed ? { display: "none" } : undefined}
      >
        <SidePanel
          side="left"
          title={title}
          isCollapsed={false}
          width={width}
          style={{
            left: navRailWidth,
            ...style,
          }}
          footer={context.footer ? context.footer : undefined}
        >
          <div data-pane="side-rail" data-scout-side-rail="" style={{ display: "contents" }}>
            {context.body}
          </div>
        </SidePanel>
      </div>

      <div
        className="scout-side-rail-collapsed-host"
        data-presentation={presentation}
        data-collapsed={isCollapsed ? "true" : "false"}
        hidden={!isCollapsed}
        aria-hidden={!isCollapsed}
        style={!isCollapsed ? { display: "none" } : undefined}
      >
        <CollapsedRail
          side="left"
          title={title}
          onToggle={onToggleCollapse}
          edgeOffset={navRailWidth}
          top={top}
          style={style}
          body={<SideRailCollapsedBody route={route} onExpand={onToggleCollapse} />}
        />
      </div>

      {/* Outside both hosts: one control, one DOM node, alive in both states —
          so collapsing cannot swap it for a different-looking widget somewhere
          else on the column. */}
      <RailToggle
        side="left"
        collapsed={isCollapsed}
        label={title}
        onToggle={onToggleCollapse}
        onMouseDown={(e) => e.stopPropagation()}
        className="scout-rail-toggle--band"
        style={{
          position: "fixed",
          left: toggleLeft,
          top: top + RAIL_TOGGLE_HEADER_TOP,
          zIndex: 45,
        }}
      />
    </>
  );
}
