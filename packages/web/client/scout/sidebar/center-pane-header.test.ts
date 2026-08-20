import { describe, expect, test } from "bun:test";
import { routeBreadcrumbForRoute } from "../route-breadcrumb.ts";
import { areaSubNavForRoute } from "../nav-destinations.ts";
import { primaryAreaForRoute, ROUTE_AREA_BY_VIEW } from "../primary-areas.ts";
import {
  hasSecondaryNavRow,
  secondaryNavKindForRoute,
} from "./center-pane-header-state.ts";

/**
 * Breadcrumb header seam coverage (SCO-085 / SCO-086).
 * CenterPaneHeader composes these pure projections — assert the seam inputs
 * for a sample of routes without mounting React chrome.
 */
describe("center-pane header seam projections (SCO-085 / SCO-086)", () => {
  test("breadcrumb renders for sample detail routes", () => {
    expect(routeBreadcrumbForRoute({ view: "terminal" })).toBe("Terminals");
    expect(routeBreadcrumbForRoute({ view: "repos" })).toBe("Repositories");
    expect(routeBreadcrumbForRoute({ view: "code" })).toBe("Code Browser");
    expect(routeBreadcrumbForRoute({ view: "ops", mode: "lanes" })).toBe("Agent Lanes");
    expect(routeBreadcrumbForRoute({ view: "broker" })).toBe("Dispatch");
  });

  test("breadcrumb is null on top-level area landings that need no crumb", () => {
    expect(routeBreadcrumbForRoute({ view: "inbox" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "agents-v2" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "sessions" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "messages" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "search" })).toBeNull();
  });

  test("area sub-nav strip is present for projects/sessions mouse paths", () => {
    const projects = areaSubNavForRoute({ view: "agents-v2" });
    expect(projects?.items.map((i) => i.label)).toEqual(["Projects", "Repositories", "Code Browser"]);

    const terminals = areaSubNavForRoute({ view: "terminal" });
    expect(terminals?.items.map((i) => i.id)).toEqual(["sessions", "terminals"]);
    expect(terminals?.items.find((i) => i.id === "terminals")?.active({ view: "terminal" })).toBe(
      true,
    );
  });

  test("header seam has content when either breadcrumb or sub-nav applies", () => {
    const samples = [
      { view: "inbox" as const },
      { view: "agents-v2" as const },
      { view: "code" as const },
      { view: "terminal" as const },
      { view: "ops" as const, mode: "lanes" as const },
      { view: "broker" as const },
    ];
    for (const route of samples) {
      const crumb = routeBreadcrumbForRoute(route);
      const sub = areaSubNavForRoute(route);
      const secondary = secondaryNavKindForRoute(route);
      const hasSeam = Boolean(crumb) || Boolean(sub) || Boolean(secondary);
      // Top-level landings without sub-nav stay flush (Home, Search, Chat, …).
      if (route.view === "inbox") expect(hasSeam).toBe(false);
      if (route.view === "agents-v2") expect(hasSeam).toBe(true); // sub-nav
      if (route.view === "code") expect(hasSeam).toBe(true); // crumb + sub-nav
      if (route.view === "terminal") expect(hasSeam).toBe(true);
      if (route.view === "ops") expect(hasSeam).toBe(true); // crumb + ops secondary
      if (route.view === "broker") expect(hasSeam).toBe(true); // crumb
    }
  });

  test("areaSubNavForRoute is parity-aligned with ROUTE_AREA_BY_VIEW", () => {
    for (const [view, areaId] of Object.entries(ROUTE_AREA_BY_VIEW) as Array<
      [keyof typeof ROUTE_AREA_BY_VIEW, (typeof ROUTE_AREA_BY_VIEW)[keyof typeof ROUTE_AREA_BY_VIEW]]
    >) {
      const route = { view } as Parameters<typeof areaSubNavForRoute>[0];
      const sub = areaSubNavForRoute(route);
      if (areaId === "projects" || areaId === "sessions") {
        expect(sub?.areaId).toBe(areaId);
        expect(primaryAreaForRoute(route)).toBe(areaId);
      } else {
        expect(sub).toBeNull();
      }
    }
  });

  test("title bar owns only the Operations secondary strip", () => {
    expect(secondaryNavKindForRoute({ view: "ops", mode: "lanes" })).toBe("ops");
    expect(secondaryNavKindForRoute({ view: "mesh" })).toBe("ops");
    expect(secondaryNavKindForRoute({ view: "harnesses" })).toBe("ops");
    // Route unification retired the Chat strip: one conversation route,
    // nothing left to switch between.
    expect(secondaryNavKindForRoute({ view: "messages" })).toBeNull();
    expect(secondaryNavKindForRoute({ view: "inbox" })).toBeNull();
    expect(secondaryNavKindForRoute({ view: "agents-v2" })).toBeNull();
  });

  // SCO-088b/c: the top row is ONE 40px band (the sco-087b second stacked row is
  // superseded). hasSecondaryNavRow now gates whether the INLINE tab cluster (and
  // its slash separator) render beside the section name — either the Ops/Chat
  // strip OR the projects/sessions area sub-nav.
  test("hasSecondaryNavRow is true for Operations and area-sub-nav routes", () => {
    // Ops secondary strip.
    expect(hasSecondaryNavRow({ view: "ops", mode: "lanes" })).toBe(true);
    expect(hasSecondaryNavRow({ view: "mesh" })).toBe(true);
    expect(hasSecondaryNavRow({ view: "harnesses" })).toBe(true);
    // Projects / Sessions area sub-nav (no Ops kind, still an inline cluster).
    expect(secondaryNavKindForRoute({ view: "agents-v2" })).toBeNull();
    expect(hasSecondaryNavRow({ view: "agents-v2" })).toBe(true);
    expect(hasSecondaryNavRow({ view: "terminal" })).toBe(true);
    expect(hasSecondaryNavRow({ view: "code" })).toBe(true);
  });

  test("hasSecondaryNavRow is false on flush landings — section name only", () => {
    // No tab cluster: the top row shows just the section name (no slash, no tabs).
    expect(hasSecondaryNavRow({ view: "inbox" })).toBe(false);
    expect(hasSecondaryNavRow({ view: "search" })).toBe(false);
    // Chat flushes too now — the rail is the only chat nav (D1/D6).
    expect(hasSecondaryNavRow({ view: "messages" })).toBe(false);
  });
});
