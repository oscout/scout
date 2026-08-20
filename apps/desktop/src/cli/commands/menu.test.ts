import { describe, expect, test } from "bun:test";

import { parseMenuCommand, renderMenuCommandHelp } from "./menu.ts";

describe("menu command helpers", () => {
  test("documents the quick launch flow", () => {
    expect(renderMenuCommandHelp()).toContain("scout menu");
    expect(renderMenuCommandHelp()).toContain("scout menu restart");
  });

  test("defaults to launch", () => {
    expect(parseMenuCommand([])).toEqual({
      action: "launch",
      passthroughArgs: [],
    });
  });

  test("normalizes common aliases", () => {
    expect(parseMenuCommand(["open"]).action).toBe("launch");
    expect(parseMenuCommand(["start"]).action).toBe("launch");
    expect(parseMenuCommand(["stop"]).action).toBe("quit");
  });

  test("treats leading flags as launch passthrough", () => {
    expect(parseMenuCommand(["--version", "0.2.16"])).toEqual({
      action: "launch",
      passthroughArgs: ["--version", "0.2.16"],
    });
  });
});
