import { describe, expect, test } from "bun:test";
import type { ObserveFile } from "../../lib/types.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import { buildSharedWorkArtifacts } from "./shared-work-artifacts.ts";

function lane(id: string, cwd: string | undefined, files: ObserveFile[]): AgentLane {
  return { id, agent: { name: id, cwd }, observe: { events: [], files } } as unknown as AgentLane;
}
const file = (path: string, state: ObserveFile["state"] = "modified"): ObserveFile => ({ path, state, touches: 1, lastT: 2 });

describe("shared work artifacts", () => {
  test("relative and absolute aliases resolve to one file in a normalized workspace", () => {
    const artifacts = buildSharedWorkArtifacts([
      lane("a", "/repo/./", [file("src/../src/main.ts")]),
      lane("b", "/repo", [file("/repo//src/main.ts")]),
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ workspace: "/repo", path: "src/main.ts", resolvedPath: "/repo/src/main.ts", state: "modified" });
    expect(artifacts[0].owners.map((owner) => owner.id)).toEqual(["a", "b"]);
  });
  test("separate worktrees retain independent artifact identities", () => {
    const artifacts = buildSharedWorkArtifacts([
      lane("a", "/repo", [file("src/main.ts"), file("/shared/config.json")]),
      lane("b", "/worktrees/feature", [file("src/main.ts"), file("/shared/config.json")]),
    ]);
    expect(artifacts).toHaveLength(4);
    expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(4);
  });
  test("unknown or relative workspaces never merge different lanes", () => {
    const artifacts = buildSharedWorkArtifacts([
      lane("a", undefined, [file("src/main.ts"), file("/shared/config.json")]),
      lane("b", "repo", [file("src/main.ts"), file("/shared/config.json")]),
    ]);
    expect(artifacts).toHaveLength(4);
    expect(artifacts.every((artifact) => artifact.owners.length === 1 && artifact.workspace === null)).toBe(true);
    expect(artifacts.filter((artifact) => artifact.path === "src/main.ts").every((artifact) => artifact.resolvedPath === null)).toBe(true);
  });
  test("duplicate aliases and repeated lanes contribute one owner", () => {
    const actor = lane("a", "/repo", [file("src/main.ts"), file("/repo/src/main.ts", "created")]);
    const [artifact] = buildSharedWorkArtifacts([actor, actor]);
    expect(artifact.owners).toHaveLength(1);
    expect(artifact.state).toBe("created");
  });
  test("read-only observations do not create artifacts or contributors", () => {
    const artifacts = buildSharedWorkArtifacts([
      lane("reader", "/repo", [file("src/main.ts", "read"), file("README.md", "read")]),
      lane("writer", "/repo", [file("src/main.ts")]),
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].owners.map((owner) => owner.id)).toEqual(["writer"]);
  });
});
