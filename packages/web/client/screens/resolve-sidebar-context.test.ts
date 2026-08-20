import { describe, expect, test } from "bun:test";
import type { Route } from "../lib/types.ts";
import { allRouteViews, ROUTE_AREA_BY_VIEW } from "../scout/primary-areas.ts";

/**
 * Unit-level exhaustiveness for resolveSidebarContext without mounting React.
 * Source is scanned for a case per view so HomeLeft cannot reappear as a
 * silent default.
 */
describe("resolveSidebarContext exhaustiveness (SCO-083)", () => {
  test("source switch lists every Route view (no HomeLeft fallback)", async () => {
    const source = await Bun.file(
      new URL("./resolve-sidebar-context.tsx", import.meta.url),
    ).text();

    // No default → HomeLeft pattern from resolveLeftPane.
    expect(source).not.toMatch(/case\s+"inbox"\s*,\s*\n\s*default/);
    expect(source).not.toContain('default:\n      return <HomeLeft');
    expect(source).toContain("const _exhaustive: never = route");

    for (const view of allRouteViews()) {
      // Each view appears as a case label (string match).
      expect(source).toContain(`case "${view}"`);
    }

    // Mesh preserves the minimap host.
    expect(source).toContain("MeshCanvasMinimap");
    // HomeLeft is intentional for home area only.
    expect(source).toContain("HomeLeft");
    expect(ROUTE_AREA_BY_VIEW.inbox).toBe("home");
  });

  test("follow and former HomeLeft fallbacks are classified (not Home)", () => {
    const nonHomeFallbacks: Route["view"][] = [
      "sessions",
      "broker",
      "search",
      "settings",
      "work",
      "repos",
      "code",
      "harnesses",
      "follow",
    ];
    for (const view of nonHomeFallbacks) {
      expect(ROUTE_AREA_BY_VIEW[view]).not.toBe("home");
    }
  });
});
