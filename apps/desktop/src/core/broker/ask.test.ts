import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { buildScoutAskRoute } from "./ask.ts";

describe("buildScoutAskRoute", () => {
  test("keeps direct --to values as existing agent-label routes", () => {
    expect(buildScoutAskRoute({
      to: "Fable",
      currentDirectory: "/tmp/openscout",
    })).toEqual({
      kind: "agent_label",
      label: "Fable",
    });
  });

  test("builds explicit broker runtime-profile routes for the current project", () => {
    expect(buildScoutAskRoute({
      to: "",
      runtimeProfile: "opus",
      currentDirectory: "/tmp/openscout",
      reasoningEffort: "high",
    })).toEqual({
      kind: "runtime_profile",
      profile: "opus",
      projectPath: "/tmp/openscout",
      reasoningEffort: "high",
    });
  });

  test("normalizes a runtime profile's inferred project path to an absolute path", () => {
    expect(buildScoutAskRoute({
      to: "",
      runtimeProfile: "fable",
      currentDirectory: "relative/project",
    })).toEqual({
      kind: "runtime_profile",
      profile: "fable",
      projectPath: resolve("relative/project"),
    });
  });

  test("uses an explicit project to narrow a runtime-profile launch", () => {
    expect(buildScoutAskRoute({
      to: "",
      runtimeProfile: "fable",
      projectPath: "../talkie",
      currentDirectory: "/tmp/openscout",
    })).toEqual({
      kind: "runtime_profile",
      profile: "fable",
      projectPath: "/tmp/talkie",
    });
  });

  test("builds a distinct exact existing-handle route", () => {
    expect(buildScoutAskRoute({
      to: "",
      existingHandle: "@composer-review",
      currentDirectory: "/tmp/openscout",
    })).toEqual({
      kind: "existing_handle",
      handle: "composer-review",
      value: "@composer-review",
    });
  });

  test("preserves explicit route-alias scope without changing direct target semantics", () => {
    expect(buildScoutAskRoute({
      to: "alias:review",
      currentDirectory: "/tmp/openscout",
      aliasScope: { projectRoot: "/tmp/talkie", nodeId: "mini" },
    })).toEqual({
      kind: "route_alias",
      alias: "review",
      value: "alias:review",
      scope: { projectRoot: "/tmp/talkie", nodeId: "mini" },
    });
  });
});
