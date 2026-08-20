/**
 * Shared center-pane header / page title bar (SCO-085 / SCO-086).
 *
 * Slim title bar above ScoutContent:
 * - Route breadcrumb (left)
 * - AREA_SUB_NAV strip (projects/sessions)
 * - OpsSubnav owned here when sidebar chrome is on
 * - Optional RIGHT-UTILITY slot for screen-level header actions
 *
 * Routes that intentionally return null (no title bar):
 * - Home landings: inbox (no crumb, no secondary strip)
 * - Other flush landings depend on breadcrumb + area projections;
 *   see routeBreadcrumbForRoute / areaSubNavForRoute / secondaryNavForRoute.
 *
 * One shell slot — do not hand-edit every screen for breadcrumb/subnav.
 */
import type { MouseEvent, ReactNode } from "react";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { routeBreadcrumbForRoute } from "../route-breadcrumb.ts";
import {
  areaSubNavForRoute,
  type AreaSubNavItem,
} from "../nav-destinations.ts";
import { useScout } from "../Provider.tsx";
import { getPrimaryArea, primaryAreaForRoute } from "../primary-areas.ts";
import type { Route } from "../../lib/types.ts";
import { OpsSubnav } from "../../screens/ops/OpsSubnav.tsx";
import {
  hasSecondaryNavRow,
  secondaryNavKindForRoute,
} from "./center-pane-header-state.ts";

export {
  hasSecondaryNavRow,
  secondaryNavKindForRoute,
} from "./center-pane-header-state.ts";

export function AreaSubNavStrip({
  items,
  route,
  navigate,
  className = "",
}: {
  items: AreaSubNavItem[];
  route: Route;
  navigate: (route: Route) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      className={`scout-area-subnav${className ? ` ${className}` : ""}`}
      aria-label="Area sub-navigation"
      data-scout-area-subnav=""
    >
      {items.map((item) => {
        const active = item.active(route);
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            className={`scout-area-subnav-item${active ? " scout-area-subnav-item--active" : ""}`}
            onClick={() => navigate(item.route)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Shell-owned page title bar: breadcrumb, area sub-nav, Ops/Chat strips,
 * optional right-utility actions.
 * Returns null when nothing applies (keeps the center pane flush).
 */
export function CenterPaneHeader({
  rightUtility,
  variant,
  presentation = "scout",
  onOpenSearch,
  onInteractiveMouseDown,
}: {
  /** Right-aligned utility slot for screen-level header actions. */
  rightUtility?: ReactNode;
  /**
   * "top-row" renders the header as the fixed app-wide top row (SCO-087):
   * always mounted, no sticky, sits inside a drag-region wrapper.
   */
  variant?: "top-row";
  presentation?: "scout" | "slack";
  onOpenSearch?: () => void;
  /** Marks interactive groups no-drag when hosted inside a drag region. */
  onInteractiveMouseDown?: (event: MouseEvent) => void;
} = {}) {
  const { route, navigate, navigateBack, canNavigateBack } = useScout();
  const breadcrumb = routeBreadcrumbForRoute(route);
  const subNav = areaSubNavForRoute(route);
  const secondaryKind = secondaryNavKindForRoute(route);
  const isTopRow = variant === "top-row";
  const showSecondaryRow = Boolean(subNav) || secondaryKind !== null;

  // The top row is the app frame: it always mounts (it hosts machine scope +
  // utilities + the drag region), even on flush landings with no crumb/sub-nav.
  if (!isTopRow && !breadcrumb && !subNav && !secondaryKind && !rightUtility) {
    return null;
  }

  // SCO-087b: the secondary content nav (area sub-nav, Ops/Chat strips) is the
  // "tabs" the user wants OUT of the title bar. Shared by both variants.
  const secondaryNav = showSecondaryRow ? (
    <>
      {subNav ? (
        <AreaSubNavStrip items={subNav.items} route={route} navigate={navigate} />
      ) : null}
      {secondaryKind === "ops" ? (
        <div className="scout-center-pane-secondary" data-scout-secondary-nav="ops">
          <OpsSubnav activeRoute={route} navigate={navigate} />
        </div>
      ) : null}
    </>
  ) : null;

  // SCO-088b/c: ONE 40px top row. It LEADS with the current section name in title
  // form (the primary-area label, e.g. "Sessions"), breadcrumb-style: section name
  // · " / " · the AREA_SUB_NAV tabs. When the area has no sub-nav, only the section
  // name shows (no slash, no duplication). Using the section label — not the deep
  // route breadcrumb — avoids a dim leaf that duplicates the active tab (the old
  // /ops/lanes "Lanes" case). Tabs never wrap; they scroll. Utilities pinned right.
  if (isTopRow) {
    const sectionName = getPrimaryArea(primaryAreaForRoute(route)).label;
    if (presentation === "slack") {
      const slackSectionName = primaryAreaForRoute(route) === "chat"
        ? "Home"
        : primaryAreaForRoute(route) === "home"
          ? "Activity"
          : sectionName;
      return (
        <div
          className="scout-center-pane-header scout-center-pane-header--top-row scout-slack-topbar"
          data-scout-center-pane-header=""
          data-scout-top-row=""
          data-presentation="slack"
        >
          <div
            className="scout-slack-topbar-history"
            onMouseDown={onInteractiveMouseDown}
          >
            <button
              type="button"
              aria-label="Go back"
              title="Go back"
              onClick={() => window.history.back()}
            >
              <ArrowLeft size={16} strokeWidth={1.8} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Go forward"
              title="Go forward"
              onClick={() => window.history.forward()}
            >
              <ArrowRight size={16} strokeWidth={1.8} aria-hidden />
            </button>
            <span>{slackSectionName}</span>
          </div>

          <button
            type="button"
            className="scout-slack-topbar-search"
            aria-label="Search Scout"
            onMouseDown={onInteractiveMouseDown}
            onClick={onOpenSearch}
          >
            <Search size={15} strokeWidth={1.8} aria-hidden />
            <span>Search Scout</span>
            <kbd>⌘K</kbd>
          </button>

          {rightUtility ? (
            <div
              className="scout-center-pane-header-utility scout-slack-topbar-utility"
              data-scout-header-utility=""
              onMouseDown={onInteractiveMouseDown}
            >
              {rightUtility}
            </div>
          ) : <span />}
        </div>
      );
    }

    return (
      <div
        className="scout-center-pane-header scout-center-pane-header--top-row"
        data-scout-center-pane-header=""
        data-scout-top-row=""
        data-scout-has-secondary-row={showSecondaryRow ? "" : undefined}
      >
        <div
          className="scout-center-pane-header-main"
          onMouseDown={onInteractiveMouseDown}
        >
          <button
            type="button"
            className="scout-top-row-back"
            aria-label="Back"
            aria-keyshortcuts="Meta+["
            title="Back (⌘[)"
            disabled={!canNavigateBack}
            onClick={navigateBack}
          >
            <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <div className="scout-center-pane-breadcrumb" data-scout-breadcrumb="">
            <span className="scout-nav-crumb">{sectionName}</span>
          </div>
          {showSecondaryRow ? (
            <span className="scout-top-row-sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {secondaryNav}
        </div>
        {rightUtility ? (
          <div
            className="scout-center-pane-header-utility"
            data-scout-header-utility=""
            onMouseDown={onInteractiveMouseDown}
          >
            {rightUtility}
          </div>
        ) : null}
      </div>
    );
  }

  // Legacy / non-top-row seam (kept single-row for the ?ff.nav.sidebar=off path).
  return (
    <div
      className="scout-center-pane-header"
      data-scout-center-pane-header=""
    >
      <div className="scout-center-pane-header-main" onMouseDown={onInteractiveMouseDown}>
        {breadcrumb ? (
          <div className="scout-center-pane-breadcrumb" data-scout-breadcrumb="">
            <span className="scout-nav-crumb">{breadcrumb}</span>
          </div>
        ) : null}
        {secondaryNav}
      </div>
      {rightUtility ? (
        <div
          className="scout-center-pane-header-utility"
          data-scout-header-utility=""
          onMouseDown={onInteractiveMouseDown}
        >
          {rightUtility}
        </div>
      ) : null}
    </div>
  );
}
