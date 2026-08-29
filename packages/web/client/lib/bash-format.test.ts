import { describe, expect, test } from "bun:test";

import {
  bashDisplaySpans,
  formatBashLine,
  splitCdPrefix,
  tildeShortenPath,
} from "./bash-format.ts";

/** Compact view: PROG in [brackets], dim in ·dots·, dir in {braces}, args plain. */
function shape(command: string): string {
  return bashDisplaySpans(command)
    .map((s) =>
      s.tier === "prog" ? `[${s.text}]`
        : s.tier === "dim" ? `·${s.text}·`
          : s.tier === "dir" ? `{${s.text}}`
            : s.text,
    )
    .join(" ");
}

describe("bashDisplaySpans", () => {
  test("spotlights the first real program, dims operators + piped helpers", () => {
    expect(shape("git log --oneline | grep fix | head -20")).toBe(
      "[git] log --oneline ·|· ·grep· ·fix· ·|· ·head· ·-20·",
    );
  });

  test("dims env-assignment prefixes but still finds the program", () => {
    expect(shape("FORCE=1 NODE_ENV=prod node build.js --watch")).toBe(
      "·FORCE=1· ·NODE_ENV=prod· [node] build.js --watch",
    );
  });

  test("dims command wrappers (sudo) and spotlights the wrapped program", () => {
    expect(shape("sudo lsof -i :43140")).toBe("·sudo· [lsof] -i :43140");
  });

  test("a path-program is the program (and still recognised by basename)", () => {
    const spans = bashDisplaySpans("./node_modules/.bin/tsc --noEmit -p tsconfig.json");
    expect(spans[0]).toMatchObject({ text: "./node_modules/.bin/tsc", tier: "prog", known: true });
  });

  test("marks recognised commands known, unrecognised not", () => {
    expect(bashDisplaySpans("rg foo")[0]?.known).toBe(true);
    expect(bashDisplaySpans("./scripts/mytool foo")[0]?.known).toBe(false);
  });

  test("flags args read as flags", () => {
    const spans = bashDisplaySpans("node build.js --watch");
    expect(spans.find((s) => s.text === "--watch")?.flag).toBe(true);
    expect(spans.find((s) => s.text === "build.js")?.flag).toBe(false);
  });

  test("a cd destination gets the thoughtful dir tier (not buried as plumbing)", () => {
    expect(shape("cd /Users/art/dev/x && bun run build")).toBe(
      "·cd· {~/dev/x} ·&&· [bun] run build",
    );
  });
});

describe("splitCdPrefix", () => {
  test("pulls a leading cd …&& into a tilde-shortened dir + the rest", () => {
    expect(splitCdPrefix("cd /Users/art/dev/x && bun run build")).toEqual({
      dir: "~/dev/x",
      rest: "bun run build",
    });
  });

  test("a bare cd has a dir and no remaining command", () => {
    expect(splitCdPrefix("cd ../stuff")).toEqual({ dir: "../stuff", rest: "" });
  });

  test("no leading cd → null dir, command unchanged", () => {
    expect(splitCdPrefix("bun test")).toEqual({ dir: null, rest: "bun test" });
  });
});

describe("formatBashLine — powerline modes", () => {
  const CMD = "cd /Users/art/dev/x && bun bin/app.ts 2>&1 | tail -5";

  test("default (off): no powerline, cd reads inline with the dir tier", () => {
    const line = formatBashLine(CMD);
    expect(line.dir).toBe(null);
    expect(line.spans[0]).toMatchObject({ text: "cd", tier: "dim" });
    expect(line.spans[1]).toMatchObject({ text: "~/dev/x", tier: "dir" });
    expect(line.spans.find((s) => s.text === "bun")).toMatchObject({ tier: "prog" });
  });

  test("always: lifts the cd into a powerline dir + drops it from the command", () => {
    const line = formatBashLine(CMD, { powerline: "always" });
    expect(line.dir).toBe("~/dev/x");
    expect(line.spans[0]).toMatchObject({ text: "bun", tier: "prog" });
    expect(line.spans.some((s) => s.text === "cd")).toBe(false);
  });

  test("smart: a redundant cd back to the cwd is dropped, no segment", () => {
    const line = formatBashLine(CMD, { powerline: "smart", cwd: "/Users/art/dev/x" });
    expect(line.dir).toBe(null);
    expect(line.spans[0]).toMatchObject({ text: "bun", tier: "prog" });
    expect(line.spans.some((s) => s.text === "cd")).toBe(false);
  });

  test("smart: a cd to a DIFFERENT directory keeps the segment", () => {
    const line = formatBashLine(CMD, { powerline: "smart", cwd: "/Users/art/other" });
    expect(line.dir).toBe("~/dev/x");
  });
});

describe("tildeShortenPath", () => {
  test("collapses the home prefix to ~", () => {
    expect(tildeShortenPath("/Users/art/dev/openscout/x")).toBe("~/dev/openscout/x");
  });
});
