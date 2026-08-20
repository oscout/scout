import { describe, expect, test } from "bun:test";

import { codeProjectSlug, matchCodeProjectBySlug } from "./code-project-resolve.ts";

const inventory = [
  { displayName: "OpenScout", projectRoot: "/Users/example/dev/openscout" },
  { displayName: "openscout", projectRoot: "/Users/example/.codex/worktrees/4f8f/openscout" },
  { displayName: "Action", projectRoot: "/Users/example/dev/action" },
  { displayName: "Workspace Map", projectRoot: "/Users/example/dev/lattices-worktrees/workspace-map" },
  { displayName: "Staging", projectRoot: "/Users/example/dev/openscout-staging" },
];

describe("codeProjectSlug", () => {
  test("lowercases and collapses separators like the client", () => {
    expect(codeProjectSlug("Workspace Map")).toBe("workspace-map");
    expect(codeProjectSlug("OpenScout")).toBe("openscout");
    expect(codeProjectSlug("--Action__")).toBe("action");
  });
});

describe("matchCodeProjectBySlug", () => {
  test("resolves a cold checkout by folder name", () => {
    expect(matchCodeProjectBySlug(inventory, "action")?.projectRoot)
      .toBe("/Users/example/dev/action");
  });

  test("prefers the shortest root among same-named checkouts", () => {
    expect(matchCodeProjectBySlug(inventory, "openscout")?.projectRoot)
      .toBe("/Users/example/dev/openscout");
  });

  test("suffixed folder names are distinct slugs", () => {
    expect(matchCodeProjectBySlug(inventory, "openscout-staging")?.projectRoot)
      .toBe("/Users/example/dev/openscout-staging");
  });

  test("falls back to display-name match when no folder matches", () => {
    const named = [{ displayName: "Blink Console", projectRoot: "/Users/example/dev/bc" }];
    expect(matchCodeProjectBySlug(named, "blink-console")?.projectRoot)
      .toBe("/Users/example/dev/bc");
  });

  test("unknown slug and empty slug return null", () => {
    expect(matchCodeProjectBySlug(inventory, "no-such-project")).toBeNull();
    expect(matchCodeProjectBySlug(inventory, "  ")).toBeNull();
  });
});
