import { describe, expect, test } from "bun:test";
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
});
