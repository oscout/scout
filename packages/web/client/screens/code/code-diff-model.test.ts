import { describe, expect, test } from "bun:test";
import type { RepoDiffFile, RepoDiffLayer, RepoDiffLayerKind } from "../../scout/repo-diff/types.ts";
import {
  diffFileIndex,
  firstChangedLayer,
  relativeFilePath,
} from "./code-diff-model.ts";

function file(oldPath: string | null, newPath: string | null): RepoDiffFile {
  return {
    oldPath,
    newPath,
    status: "modified",
    oldOid: null,
    newOid: null,
    oldMode: null,
    newMode: null,
    similarity: null,
    binary: false,
    additions: 1,
    deletions: 1,
    hunks: [],
    truncated: false,
  };
}

function layer(kind: RepoDiffLayerKind, files: RepoDiffFile[]): RepoDiffLayer {
  return {
    kind,
    baseLabel: null,
    compareLabel: null,
    command: [],
    patchOid: kind,
    rawPatch: "",
    rawPatchBytes: 0,
    truncated: false,
    files,
    shortstat: null,
  };
}

describe("code diff identity", () => {
  test("derives only strict, normalized descendants of the selected root", () => {
    expect(relativeFilePath("/repo", "/repo/src/app.ts")).toBe("src/app.ts");
    expect(relativeFilePath("/repo/", "/repo/src/../app.ts")).toBe("app.ts");
    expect(relativeFilePath("/repo", "/repo-other/app.ts")).toBeNull();
    expect(relativeFilePath("/repo", "/repo/../elsewhere/app.ts")).toBeNull();
    expect(relativeFilePath("/repo", "/repo")).toBeNull();
  });

  test("matches the requested old or new path without trusting the first file", () => {
    const candidate = layer("unstaged", [
      file("src/other.ts", "src/other.ts"),
      file("src/old.ts", "src/app.ts"),
    ]);
    expect(diffFileIndex(candidate, "src/app.ts")).toBe(1);
    expect(diffFileIndex(candidate, "src/old.ts")).toBe(1);
    expect(diffFileIndex(candidate, "src/missing.ts")).toBe(-1);
  });

  test("selects the first layer that actually contains the requested file", () => {
    const layers = [
      layer("unstaged", [file("src/other.ts", "src/other.ts")]),
      layer("staged", []),
      layer("branch", [file("src/app.ts", "src/app.ts")]),
    ];
    expect(firstChangedLayer(layers, "src/app.ts")).toBe("branch");
    expect(firstChangedLayer(layers, "src/missing.ts")).toBeNull();
  });
});
