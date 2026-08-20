import { describe, expect, test } from "bun:test";
import { SYSTEM_OPS_ENTRIES } from "./nav-system-menu-config.ts";
import { OPS_SECONDARY_NAV } from "./secondaryNavConfig.ts";

describe("ops secondary nav", () => {
  test("keeps Mission Control reachable inside the ops cluster", () => {
    const missionControl = OPS_SECONDARY_NAV
      .flatMap((group) => group.items)
      .find((item) => item.id === "control");

    expect(missionControl).toBeDefined();
    expect(missionControl?.label).toBe("Mission Control");
    expect(missionControl?.route).toEqual({ view: "ops", mode: "mission" });
    expect(missionControl?.active({ view: "ops" })).toBe(true);
    expect(missionControl?.active({ view: "ops", mode: "mission" })).toBe(true);
  });

  test("exposes Mission Control from the simplified nav's System menu", () => {
    const missionControl = SYSTEM_OPS_ENTRIES.find((item) => item.key === "control");

    expect(missionControl).toBeDefined();
    expect(missionControl?.label).toBe("Mission Control");
    expect(missionControl?.route).toEqual({ view: "ops", mode: "mission" });
    expect(missionControl?.active({ view: "ops" })).toBe(true);
    expect(missionControl?.active({ view: "ops", mode: "mission" })).toBe(true);
  });
});
