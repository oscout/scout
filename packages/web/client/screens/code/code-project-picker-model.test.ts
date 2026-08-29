import { describe, expect, test } from "bun:test";
import {
  filterProjectOptions,
  flattenProjectOptions,
  optionChipLabel,
  optionDetailLabel,
  scoreProjectOption,
  shortRootPath,
  type CodeProjectOption,
  type CodeProjectSource,
} from "./code-project-picker-model.ts";

const projects: CodeProjectSource[] = [
  {
    id: "p-openscout",
    name: "openscout",
    worktrees: [
      {
        id: "wt-main",
        path: "/Users/art/dev/openscout",
        name: "openscout",
        branch: { detached: false, name: "main" },
        status: { clean: false, changedFiles: 18 },
      },
      {
        id: "wt-comms",
        path: "/Users/art/dev/openscout-worktrees/comms",
        name: "comms",
        branch: { detached: false, name: "codex/comms-routing" },
        status: { clean: true, changedFiles: 0 },
      },
    ],
  },
  {
    id: "p-talkie",
    name: "talkie",
    worktrees: [
      {
        id: "wt-talkie",
        path: "/Users/art/dev/talkie",
        name: "talkie",
        branch: { detached: false, name: "main" },
        status: { clean: true, changedFiles: 0 },
      },
    ],
  },
  {
    id: "p-lattices",
    name: "lattices",
    worktrees: [
      {
        id: "wt-lattices",
        path: "/Users/art/dev/lattices",
        name: "lattices",
        branch: { detached: false, name: "main" },
        status: { clean: true, changedFiles: 0 },
      },
    ],
  },
];

describe("flattenProjectOptions", () => {
  test("emits one option per worktree with primary flag on index 0", () => {
    const options = flattenProjectOptions(projects);
    expect(options).toHaveLength(4);
    expect(options[0]).toMatchObject({
      projectName: "openscout",
      root: "/Users/art/dev/openscout",
      isPrimary: true,
      branchLabel: "main",
      dirtyLabel: "18 changed",
    });
    expect(options[1]).toMatchObject({
      projectName: "openscout",
      root: "/Users/art/dev/openscout-worktrees/comms",
      isPrimary: false,
      branchLabel: "codex/comms-routing",
    });
  });
});

describe("scoreProjectOption / filterProjectOptions", () => {
  const options = flattenProjectOptions(projects);

  test("empty query ranks recents first then name", () => {
    const ranked = filterProjectOptions(
      options,
      "",
      ["/Users/art/dev/talkie", "/Users/art/dev/openscout"],
      10,
    );
    expect(ranked.map((entry) => entry.root)).toEqual([
      "/Users/art/dev/talkie",
      "/Users/art/dev/openscout",
      "/Users/art/dev/lattices",
      "/Users/art/dev/openscout-worktrees/comms",
    ]);
  });

  test("matches project name with prefix boost", () => {
    const open = options.find((entry) => entry.root === "/Users/art/dev/openscout")!;
    const talk = options.find((entry) => entry.root === "/Users/art/dev/talkie")!;
    expect(scoreProjectOption(open, "open")).toBeGreaterThan(scoreProjectOption(talk, "open"));
    expect(filterProjectOptions(options, "talk", [], 5).map((entry) => entry.projectName)).toEqual([
      "talkie",
    ]);
  });

  test("matches branch path segments", () => {
    const hits = filterProjectOptions(options, "comms", [], 5);
    expect(hits.map((entry) => entry.root)).toContain("/Users/art/dev/openscout-worktrees/comms");
  });

  test("returns empty for nonsense", () => {
    expect(filterProjectOptions(options, "zzzz-nope", [], 5)).toEqual([]);
  });
});

describe("labels", () => {
  test("chip collapses primary worktrees to the project name", () => {
    const options = flattenProjectOptions(projects);
    expect(optionChipLabel(options[0]!)).toBe("openscout");
    expect(optionChipLabel(options[1]!)).toBe("openscout · codex/comms-routing");
    expect(optionDetailLabel(options[0]!)).toBe("main · 18 changed");
    expect(optionDetailLabel(options[1]!)).toBe("codex/comms-routing");
  });

  test("shortRootPath tilde-shortens /Users paths", () => {
    expect(shortRootPath("/Users/art/dev/openscout")).toBe("~/dev/openscout");
    expect(shortRootPath("/home/art/dev/openscout")).toBe("~/dev/openscout");
  });
});

describe("option typing smoke", () => {
  test("CodeProjectOption shape is stable for the picker", () => {
    const sample: CodeProjectOption = flattenProjectOptions(projects)[0]!;
    expect(sample.projectSlug).toBe("openscout");
  });
});
