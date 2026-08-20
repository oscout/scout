import { describe, expect, test } from "bun:test";
import type { Route } from "../lib/types.ts";
import {
  PRIMARY_AREAS,
  ROUTE_AREA_BY_VIEW,
  allRouteViews,
  defaultRouteForArea,
  getPrimaryArea,
  navigatePrimaryAreas,
  primaryAreaForRoute,
  routeViewsByArea,
  systemPrimaryAreas,
  type PrimaryAreaId,
} from "./primary-areas.ts";

describe("primary areas (SCO-083 IA model)", () => {
  test("defines exactly eight primary areas with unique ids", () => {
    expect(PRIMARY_AREAS).toHaveLength(8);
    const ids = PRIMARY_AREAS.map((area) => area.id);
    expect(new Set(ids).size).toBe(8);
    expect(ids).toEqual([
      "home",
      "chat",
      "projects",
      "sessions",
      "dispatch",
      "search",
      "ops",
      "settings",
    ]);
  });

  test("Navigate and System sections partition the eight areas", () => {
    expect(navigatePrimaryAreas().map((a) => a.id)).toEqual([
      "home",
      "chat",
      "projects",
      "sessions",
      "dispatch",
      "search",
    ]);
    expect(systemPrimaryAreas().map((a) => a.id)).toEqual(["ops", "settings"]);
  });

  test("ROUTE_AREA_BY_VIEW has exactly 22 keys and 8 non-empty buckets", () => {
    const views = allRouteViews();
    expect(views).toHaveLength(22);
    expect(new Set(views).size).toBe(22);

    const buckets = routeViewsByArea();
    const areaIds = Object.keys(buckets) as PrimaryAreaId[];
    expect(areaIds).toHaveLength(8);
    for (const id of areaIds) {
      expect(buckets[id].length).toBeGreaterThan(0);
    }

    // Partition matches the revised SCO-083 table.
    expect(buckets.home.sort()).toEqual(["activity", "briefings", "inbox"].sort());
    expect(buckets.projects.sort()).toEqual(
      ["agent-info", "agents-v2", "code", "repo-diff", "repos"].sort(),
    );
    expect(buckets.sessions.sort()).toEqual(["sessions", "terminal"].sort());
    // Route unification: channels are conversations, not their own view.
    expect(buckets.chat.sort()).toEqual(["conversation", "messages"].sort());
    expect(buckets.dispatch.sort()).toEqual(["broker", "follow", "work"].sort());
    expect(buckets.search).toEqual(["search"]);
    expect(buckets.ops.sort()).toEqual(["harnesses", "mesh", "mesh-ops", "ops"].sort());
    expect(buckets.settings.sort()).toEqual(["settings", "voice"].sort());
  });

  test("every Route view maps through primaryAreaForRoute", () => {
    for (const view of allRouteViews()) {
      const route = { view } as Route;
      const areaId = primaryAreaForRoute(route);
      expect(ROUTE_AREA_BY_VIEW[view]).toBe(areaId);
      expect(getPrimaryArea(areaId).id).toBe(areaId);
    }
  });

  test("follow preferredView prefers the resolved target area", () => {
    expect(primaryAreaForRoute({ view: "follow" })).toBe("dispatch");
    expect(primaryAreaForRoute({ view: "follow", preferredView: "tail" })).toBe("ops");
    expect(primaryAreaForRoute({ view: "follow", preferredView: "session" })).toBe("sessions");
    expect(primaryAreaForRoute({ view: "follow", preferredView: "chat" })).toBe("chat");
    expect(primaryAreaForRoute({ view: "follow", preferredView: "work" })).toBe("dispatch");
  });

  test("Ops default route respects ops.control gate policy", () => {
    expect(defaultRouteForArea("ops", { opsControlEnabled: true })).toEqual({
      view: "ops",
      mode: "mission",
    });
    expect(defaultRouteForArea("ops", { opsControlEnabled: false })).toEqual({
      view: "ops",
      mode: "tail",
    });
    // Other areas ignore the ops gate.
    expect(defaultRouteForArea("home", { opsControlEnabled: false })).toEqual({ view: "inbox" });
    expect(defaultRouteForArea("dispatch")).toEqual({ view: "broker" });
  });

  test("each area default route activates that area", () => {
    for (const area of PRIMARY_AREAS) {
      expect(primaryAreaForRoute(area.defaultRoute)).toBe(area.id);
    }
  });
});
