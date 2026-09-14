import { expect, test } from "bun:test";
import { projectFloorPoint, unprojectFloorPoint } from "./shared-floor-camera.ts";
test("both projections round trip world coordinates for minimap navigation", () => {
  for (const mode of ["flat", "iso"] as const) for (const [x, y] of [[0, 0], [-620, -410], [620, 410], [123, -234]]) {
    const projected = projectFloorPoint(x, y, mode);
    const result = unprojectFloorPoint(projected.x, projected.y, mode);
    expect(result.x).toBeCloseTo(x, 8); expect(result.y).toBeCloseTo(y, 8);
  }
});
