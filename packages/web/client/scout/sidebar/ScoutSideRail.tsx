/**
 * Scout side rail (SCO-084 / SCO-086) — LEFT HudsonKit SidePanel for per-area context.
 *
 * Distinct shell slot from the shadcn nav sidebar and from the legacy LeftPanel
 * path. Shares the SidePanel component with the right inspector; does not wrap
 * or restyle SidePanel into a sidebar.
 *
 * SCO-086: collapsed state is an OpenScout CollapsedRail at RAIL_COLLAPSED_WIDTH
 * (HudsonKit SidePanel collapses to a 0px floating button — not a rail).
 * Expanded panel omits onToggleCollapse; the shared RailToggle is rendered
 * externally on the panel's trailing edge.
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
  const chevronEdge = navRailWidth + width;

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
        <RailToggle
          side="left"
          collapsed={false}
          label={title}
          onToggle={onToggleCollapse}
          className="scout-rail-toggle--panel scout-rail-toggle--side-rail"
          style={{
            position: "fixed",
            left: chevronEdge,
            top: top + 6,
            zIndex: 45,
            transform: "translateX(-50%)",
          }}
        />
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
          body={<SideRailCollapsedBody route={route} />}
        />
      </div>
    </>
  );
}
