import { describe, expect, test } from "bun:test";

import { parseMenuCommand, renderMenuCommandHelp } from "./menu.ts";

describe("menu command helpers", () => {
  test("documents the quick launch flow", () => {
    const help = renderMenuCommandHelp();
    expect(help).toContain("scout menu");
    expect(help).toContain("scout menu restart");
    expect(help).not.toContain("scout menu build");
    expect(help).not.toContain("scout menu dmg");
    expect(help).not.toContain("apps/macos");
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

  test("keeps native build and DMG operations out of the public CLI", () => {
    expect(() => parseMenuCommand(["build"])).toThrow(/unknown subcommand/);
    expect(() => parseMenuCommand(["dmg"])).toThrow(/unknown subcommand/);
  });

  test("treats leading flags as launch passthrough", () => {
    expect(parseMenuCommand(["--version", "0.2.16"])).toEqual({
      action: "launch",
      passthroughArgs: ["--version", "0.2.16"],
    });
  });
});
