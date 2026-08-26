import { describe, expect, test } from "bun:test";

import {
  appVersionFromReleaseTag,
  assertPublishedAppRelease,
  findAppDmgAsset,
  parseInstallArgs,
  renderInstallCommandHelp,
  selectLatestAppRelease,
} from "./install.ts";

describe("install command helpers", () => {
  test("documents the install flow", () => {
    const help = renderInstallCommandHelp();
    expect(help).toContain("scout install");
    expect(help).toContain("--check");
    expect(help).toContain("signed + notarized");
    expect(help).toContain("macOS 26");
    expect(help).toContain("Apple silicon");
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
    expect(parseInstallArgs(["--version", "app-v0.2.92"]).version).toBe("app-v0.2.92");
    expect(parseInstallArgs(["--version=0.2.92"]).version).toBe("0.2.92");
    expect(parseInstallArgs(["--tag=v0.2.92"]).version).toBe("v0.2.92");
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
      tag_name: "app-v0.2.92",
      name: "Scout for macOS 0.2.92",
      assets: [
        asset("OpenScoutMenu-0.2.92.dmg"),
        asset("OpenScout-0.2.92.dmg"),
        asset("OpenScout.dmg"),
      ],
    };
    expect(findAppDmgAsset(release).name).toBe("OpenScout-0.2.92.dmg");
  });

  test("rejects mutable aliases when the immutable asset is missing", () => {
    const release = {
      tag_name: "app-v0.2.92",
      name: "OpenScout",
      assets: [asset("OpenScoutMenu-0.2.92.dmg"), asset("OpenScout.dmg")],
    };
    expect(() => findAppDmgAsset(release)).toThrow();
  });

  test("never selects the standalone menu DMG", () => {
    const release = {
      tag_name: "app-v0.2.92",
      name: "OpenScout",
      assets: [asset("OpenScoutMenu-0.2.92.dmg")],
    };
    expect(() => findAppDmgAsset(release)).toThrow();
  });
});

describe("app release channel", () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}`, size: 1 });

  test("parses only app release tags", () => {
    expect(appVersionFromReleaseTag("app-v0.2.92")).toBe("0.2.92");
    expect(() => appVersionFromReleaseTag("v0.2.91")).toThrow();
  });

  test("skips package releases, drafts, and app releases without the exact DMG", () => {
    const selected = selectLatestAppRelease([
      { tag_name: "v0.2.93", name: "npm", assets: [asset("receipt.json")] },
      { tag_name: "app-v0.2.94", name: "draft", draft: true, assets: [asset("OpenScout-0.2.94.dmg")] },
      { tag_name: "app-v0.2.93", name: "incomplete", assets: [asset("OpenScout.dmg")] },
      { tag_name: "app-v0.2.92", name: "app", assets: [asset("OpenScout-0.2.92.dmg")] },
    ]);
    expect(selected.tag_name).toBe("app-v0.2.92");
  });

  test("selects the highest app semver instead of trusting GitHub list order", () => {
    const selected = selectLatestAppRelease([
      { tag_name: "app-v0.2.89", name: "late backfill", assets: [asset("OpenScout-0.2.89.dmg")] },
      { tag_name: "app-v0.10.0", name: "newest", assets: [asset("OpenScout-0.10.0.dmg")] },
      { tag_name: "app-v0.2.92", name: "older", assets: [asset("OpenScout-0.2.92.dmg")] },
    ]);
    expect(selected.tag_name).toBe("app-v0.10.0");
  });

  test("rejects requested draft, prerelease, mismatched, and incomplete releases", () => {
    expect(() => assertPublishedAppRelease({
      tag_name: "app-v0.2.92",
      name: "draft",
      draft: true,
      assets: [asset("OpenScout-0.2.92.dmg")],
    }, "app-v0.2.92")).toThrow(/published stable/);
    expect(() => assertPublishedAppRelease({
      tag_name: "app-v0.2.92",
      name: "prerelease",
      prerelease: true,
      assets: [asset("OpenScout-0.2.92.dmg")],
    }, "app-v0.2.92")).toThrow(/published stable/);
    expect(() => assertPublishedAppRelease({
      tag_name: "app-v0.2.91",
      name: "wrong tag",
      assets: [asset("OpenScout-0.2.91.dmg")],
    }, "app-v0.2.92")).toThrow(/expected app-v0\.2\.92/);
    expect(() => assertPublishedAppRelease({
      tag_name: "app-v0.2.92",
      name: "incomplete",
      assets: [asset("OpenScout.dmg")],
    }, "app-v0.2.92")).toThrow(/immutable OpenScout-0\.2\.92\.dmg/);
  });
});
