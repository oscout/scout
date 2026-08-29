import type { MeshStatus } from "./types.ts";

/** Durable mesh membership is a broker bind choice, not a reachability probe. */
export function hasJoinedMesh(mesh: Pick<MeshStatus, "localNode">): boolean {
  return mesh.localNode?.advertiseScope === "mesh";
}
