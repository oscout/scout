import { describe, expect, test } from "bun:test";
import { isScopePath } from "../../scope/paths.ts";
import { PRIMARY_AREAS, primaryAreaForRoute } from "../primary-areas.ts";

describe("sidebar model seam (SCO-083)", () => {
  test("scope is path-driven, independent of nav.sidebar flag", () => {
    expect(isScopePath("/scope")).toBe(true);
    expect(isScopePath("/scope/tail")).toBe(true);
    expect(isScopePath("/ops/tail")).toBe(false);
    expect(isScopePath("/inbox")).toBe(false);
    expect(isScopePath("/")).toBe(false);
  });

  test("scout model has eight primary destinations", () => {
    expect(PRIMARY_AREAS).toHaveLength(8);
    expect(primaryAreaForRoute({ view: "ops", mode: "tail" })).toBe("ops");
    expect(primaryAreaForRoute({ view: "broker" })).toBe("dispatch");
  });
});
