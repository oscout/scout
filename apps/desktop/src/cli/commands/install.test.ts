import { describe, expect, test } from "bun:test";

import { findAppDmgAsset, parseInstallArgs, renderInstallCommandHelp } from "./install.ts";

describe("install command helpers", () => {
  test("documents the install flow", () => {
    const help = renderInstallCommandHelp();
    expect(help).toContain("scout install");
    expect(help).toContain("--check");
    expect(help).toContain("signed + notarized");
  });

  test("defaults to a latest install that relaunches", () => {
    expect(parseInstallArgs([])).toEqual({
      check: false,
      force: false,
      version: null,
      restart: true,
    });
  });

  test("parses flags", () => {
    expect(parseInstallArgs(["--check"]).check).toBe(true);
    expect(parseInstallArgs(["check"]).check).toBe(true);
    expect(parseInstallArgs(["--force"]).force).toBe(true);
    expect(parseInstallArgs(["-f"]).force).toBe(true);
    expect(parseInstallArgs(["--no-restart"]).restart).toBe(false);
    expect(parseInstallArgs(["--version", "v0.2.70"]).version).toBe("v0.2.70");
    expect(parseInstallArgs(["--version=v0.2.70"]).version).toBe("v0.2.70");
    expect(parseInstallArgs(["--tag=v0.2.70"]).version).toBe("v0.2.70");
  });

  test("rejects a bare --version and unknown flags", () => {
    expect(() => parseInstallArgs(["--version"])).toThrow();
    expect(() => parseInstallArgs(["--version", "--force"])).toThrow();
    expect(() => parseInstallArgs(["--nope"])).toThrow();
  });
});

describe("findAppDmgAsset", () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}`, size: 1 });

  test("prefers the versioned product DMG over the menu-only DMG", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout v0.2.70",
      assets: [
        asset("OpenScoutMenu-0.2.70.dmg"),
        asset("OpenScout-0.2.70.dmg"),
        asset("OpenScout.dmg"),
      ],
    };
    expect(findAppDmgAsset(release).name).toBe("OpenScout-0.2.70.dmg");
  });

  test("falls back to the latest alias when no versioned asset exists", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout",
      assets: [asset("OpenScoutMenu-0.2.70.dmg"), asset("OpenScout.dmg")],
    };
    expect(findAppDmgAsset(release).name).toBe("OpenScout.dmg");
  });

  test("never selects the standalone menu DMG", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout",
      assets: [asset("OpenScoutMenu-0.2.70.dmg")],
    };
    expect(() => findAppDmgAsset(release)).toThrow();
  });
});
