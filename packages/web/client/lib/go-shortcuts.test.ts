import { describe, expect, test } from "bun:test";
import { GO_SHORTCUTS, goShortcutForKey } from "./go-shortcuts.ts";

describe("go shortcuts", () => {
  test("maps mnemonic keys to top-level routes", () => {
    expect(goShortcutForKey("h")?.route).toEqual({ view: "inbox" });
    expect(goShortcutForKey("i")?.route).toEqual({ view: "messages" });
    expect(goShortcutForKey("p")?.route).toEqual({ view: "agents-v2" });
    expect(goShortcutForKey("t")?.route).toEqual({ view: "terminal" });
    expect(goShortcutForKey("r")?.route).toEqual({ view: "repos" });
    expect(goShortcutForKey("f")?.route).toEqual({ view: "search" });
    expect(goShortcutForKey("l")?.route).toEqual({ view: "ops", mode: "tail" });
    expect(goShortcutForKey("o")?.route).toEqual({ view: "ops" });
    expect(goShortcutForKey("d")?.route).toEqual({ view: "broker" });
  });

  test("normalizes key casing and rejects unknown keys", () => {
    expect(goShortcutForKey("H")?.route).toEqual({ view: "inbox" });
    expect(goShortcutForKey("x")).toBeNull();
  });

  test("keeps shortcut keys unique", () => {
    const keys = GO_SHORTCUTS.map((shortcut) => shortcut.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
