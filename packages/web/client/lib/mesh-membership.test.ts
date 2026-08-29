import { describe, expect, test } from "bun:test";

import type { MeshStatus } from "./types.ts";
import { hasJoinedMesh } from "./mesh-membership.ts";

describe("mesh membership", () => {
  test("tracks durable broker scope independently of peer reachability", () => {
    expect(hasJoinedMesh({
      localNode: { advertiseScope: "mesh" },
    } as Pick<MeshStatus, "localNode">)).toBe(true);
    expect(hasJoinedMesh({
      localNode: { advertiseScope: "local" },
    } as Pick<MeshStatus, "localNode">)).toBe(false);
    expect(hasJoinedMesh({ localNode: null })).toBe(false);
  });
});
