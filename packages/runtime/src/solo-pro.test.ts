import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExpandedWebAccess } from "./dist-access.ts";
import {
  defaultSoloProProbes,
  observeNativeApp,
  readSoloProStatus,
  type NativeAppObservation,
  type NativeAppProbeIO,
  type SoloProProbes,
  type SoloProServedClient,
  type SoloProStatus,
} from "./solo-pro.ts";

const VERSION = "1.4.0";
const INSTALLED = `/support/web/full/${VERSION}`;
const NOW = 1_780_000_000_000;

type World = {
  fullInstalled?: boolean;
  otherVersions?: string[];
  served?: SoloProServedClient;
  platform?: NodeJS.Platform;
  native?: NativeAppObservation;
  herdr?: boolean;
  herdrSessions?: number | null;
};

const APP_RUNNING: NativeAppObservation = {
  state: "installed",
  path: "/Applications/Scout.app",
  version: "1.4.0",
  development: false,
  running: { app: true, menu: true },
};
const APP_CLOSED: NativeAppObservation = { ...APP_RUNNING, running: { app: false, menu: false } };
const APP_MISSING: NativeAppObservation = { state: "missing", searched: ["/Applications/Scout.app"] };

function probes(world: World = {}): SoloProProbes {
  return {
    platform: world.platform ?? "darwin",
    installedFullClient: (version) => (world.fullInstalled ?? true) && version === VERSION ? INSTALLED : null,
    installedFullClientVersions: () => [...((world.fullInstalled ?? true) ? [VERSION] : []), ...(world.otherVersions ?? [])],
    nativeApp: () => world.native ?? ((world.platform ?? "darwin") === "darwin" ? APP_RUNNING : { state: "not_applicable" }),
    herdrInstalled: async () => world.herdr ?? true,
    herdrRunningSessions: async () => (world.herdrSessions === undefined ? 1 : world.herdrSessions),
  };
}

const SERVING_FULL: SoloProServedClient = { profile: "full", root: INSTALLED };
const SERVING_BASIC: SoloProServedClient = { profile: "basic", root: "/pkg/dist/client" };

const GRANTED: ExpandedWebAccess = { state: "granted", checkedAt: NOW, keyWhere: "macOS Keychain (OPENSCOUT_DIST_KEY)", account: { login: "octo", label: null } };
const DENIED: ExpandedWebAccess = { state: "denied", checkedAt: NOW, keyWhere: "macOS Keychain (OPENSCOUT_DIST_KEY)" };
const UNKNOWN: ExpandedWebAccess[] = [
  { state: "unchecked" },
  { state: "no_credential", checkedAt: NOW },
  { state: "credential_rejected", checkedAt: NOW, keyWhere: "SCOUT_DIST_KEY" },
  { state: "unavailable", checkedAt: NOW, keyWhere: "SCOUT_DIST_KEY", reason: "Couldn't reach https://console.openscout.app: timed out" },
];

function read(access: ExpandedWebAccess, world: World = {}, env: NodeJS.ProcessEnv = {}): Promise<SoloProStatus> {
  return readSoloProStatus({
    access,
    scoutVersion: VERSION,
    served: world.served ?? SERVING_FULL,
    probes: probes(world),
    env,
    now: () => NOW,
  });
}

const component = (status: SoloProStatus, id: string) => status.components.find((entry) => entry.id === id)!;
const commands = (status: SoloProStatus) =>
  [...status.access.actions, ...status.components.flatMap((entry) => entry.actions)]
    .map((action) => (action.kind === "command" ? action.command : action.kind === "link" ? action.href : action.kind));

describe("Solo Pro status: access × installed × ready", () => {
  test("confirmed access with everything installed and running is active", async () => {
    const status = await read(GRANTED);
    expect(status.phase).toBe("active");
    expect(status.access).toMatchObject({ confirmed: true, tier: "solo_pro", title: "Solo Pro" });
    expect(status.components.map((entry) => [entry.id, entry.installed, entry.ready])).toEqual([
      ["full_web_app", "installed", "ready"],
      ["native_app", "installed", "ready"],
      ["herdr", "installed", "ready"],
    ]);
  });

  test("confirmed access without the full web app is 'Finish setting up', with the install CLI", async () => {
    const status = await read(GRANTED, { fullInstalled: false, served: SERVING_BASIC });
    expect(status.phase).toBe("finish_setup");
    expect(status.headline).toBe("Finish setting up Solo Pro");
    expect(component(status, "full_web_app")).toMatchObject({ installed: "missing", ready: "not_ready" });
    expect(commands(status)).toContain("scout web install");
  });

  test("Scout for Mac is optional: missing never blocks Solo Pro, and scout install is offered", async () => {
    const status = await read(GRANTED, { native: APP_MISSING });
    expect(status.phase).toBe("active");
    expect(component(status, "native_app")).toMatchObject({ required: false, installed: "missing" });
    expect(commands(status)).toContain("scout install");
  });

  test("installed but served from before the install needs a web restart, not a reinstall", async () => {
    const status = await read(GRANTED, { served: SERVING_BASIC });
    expect(status.phase).toBe("not_ready");
    expect(component(status, "full_web_app")).toMatchObject({ installed: "installed", ready: "not_ready" });
    expect(commands(status)).toContain("scout server restart");
    expect(commands(status)).not.toContain("scout web install");
  });

  test("closing Scout for Mac doesn't mark a working full web app as broken", async () => {
    const status = await read(GRANTED, { native: APP_CLOSED });
    expect(status.phase).toBe("active");
    expect(component(status, "full_web_app")).toMatchObject({ installed: "installed", ready: "ready" });
    expect(component(status, "native_app")).toMatchObject({ installed: "installed", ready: "not_ready" });
    expect(component(status, "native_app").readyDetail).toContain("doesn't need it");
    expect(commands(status)).toContain("scout menu");
  });

  test("only the menu helper running still counts Scout for Mac as running", async () => {
    const status = await read(GRANTED, { native: { ...APP_RUNNING, running: { app: false, menu: true } } });
    expect(component(status, "native_app")).toMatchObject({ ready: "ready", readyDetail: "The menu bar helper is running." });
  });

  test("an unreadable process list is unknown, not 'not running'", async () => {
    const status = await read(GRANTED, { native: { ...APP_RUNNING, running: null } });
    expect(component(status, "native_app").ready).toBe("unknown");
    expect(status.phase).toBe("active");
    expect(commands(status)).not.toContain("scout menu");
  });

  test("a damaged bundle is reported as such, with scout install to replace it", async () => {
    const status = await read(GRANTED, { native: { state: "damaged", path: "/Applications/Scout.app", problem: "Contents/MacOS/Scout is missing or not executable" } });
    expect(component(status, "native_app")).toMatchObject({ installed: "unknown", ready: "not_ready" });
    expect(component(status, "native_app").installedDetail).toContain("not executable");
    expect(commands(status)).toContain("scout install");
    expect(status.phase).toBe("active");
  });

  test("Herdr is optional: missing or stopped never blocks active, but says how to recover", async () => {
    const missing = await read(GRANTED, { herdr: false });
    expect(missing.phase).toBe("active");
    expect(component(missing, "herdr")).toMatchObject({ installed: "missing", required: false });
    expect(commands(missing)).toContain("https://herdr.dev/docs/install/");

    const stopped = await read(GRANTED, { herdrSessions: 0 });
    expect(stopped.phase).toBe("active");
    expect(component(stopped, "herdr").ready).toBe("not_ready");
    expect(commands(stopped)).toContain("herdr server");

    const unreadable = await read(GRANTED, { herdrSessions: null });
    expect(component(unreadable, "herdr").ready).toBe("unknown");
  });

  test("off macOS, Scout for Mac is not applicable and not required", async () => {
    const status = await read(GRANTED, { platform: "linux" });
    expect(component(status, "native_app")).toMatchObject({ installed: "not_applicable", required: false });
    expect(status.phase).toBe("active");
  });

  test("a full client for another Scout version is not counted for this one", async () => {
    const status = await read(GRANTED, { fullInstalled: false, otherVersions: ["1.3.2"], served: SERVING_BASIC });
    expect(component(status, "full_web_app").installed).toBe("missing");
    expect(component(status, "full_web_app").installedDetail).toContain("1.3.2");
  });

  test("forced basic keeps an installed full client installed: selection is a readiness fact", async () => {
    const status = await read(GRANTED, { served: SERVING_BASIC }, { OPENSCOUT_WEB_CLIENT_PROFILE: "basic" });
    expect(component(status, "full_web_app")).toMatchObject({ installed: "installed", ready: "not_ready" });
    expect(component(status, "full_web_app").readyDetail).toContain("OPENSCOUT_WEB_CLIENT_PROFILE=basic");
    expect(status.phase).toBe("not_ready");
    // Neither reinstalling nor a bare restart changes a deliberate opt-out.
    expect(commands(status)).not.toContain("scout web install");
    expect(commands(status)).not.toContain("scout server restart");
  });

  test("forced basic with nothing installed is missing, and says why basic is served", async () => {
    const status = await read(GRANTED, { fullInstalled: false, served: SERVING_BASIC }, { OPENSCOUT_WEB_CLIENT_PROFILE: "basic" });
    expect(component(status, "full_web_app")).toMatchObject({ installed: "missing", ready: "not_ready" });
    expect(component(status, "full_web_app").readyDetail).toContain("OPENSCOUT_WEB_CLIENT_PROFILE=basic");
    expect(status.phase).toBe("finish_setup");
  });

  test("a source build serving the full client counts as installed and ready", async () => {
    const status = await readSoloProStatus({
      access: GRANTED,
      scoutVersion: null,
      served: { profile: "full", root: "/repo/packages/web/dist/client" },
      probes: probes({ fullInstalled: false }),
      env: {},
    });
    expect(component(status, "full_web_app")).toMatchObject({ installed: "installed", ready: "ready" });
  });
});

describe("Solo Pro status: no false upgrade or downgrade", () => {
  test.each(UNKNOWN)("$state with everything installed is unconfirmed, not Solo Pro", async (access) => {
    const status = await read(access);
    expect(status.phase).toBe("unconfirmed");
    expect(status.access.confirmed).toBe(false);
    expect(status.access.tier).toBeNull();
    expect(status.headline).not.toContain("set up");
  });

  test.each(UNKNOWN)("$state with nothing installed is still unconfirmed, not 'no access'", async (access) => {
    const status = await read(access, { fullInstalled: false, native: APP_MISSING, herdr: false, served: SERVING_BASIC });
    expect(status.phase).toBe("unconfirmed");
    expect(status.access.tier).toBeNull();
  });

  test("denied with the full web app already installed stays denied; nothing is removed or offered for removal", async () => {
    const status = await read(DENIED);
    expect(status.phase).toBe("no_access");
    expect(status.access).toMatchObject({ confirmed: true, tier: "solo" });
    expect(component(status, "full_web_app").installed).toBe("installed");
    expect(commands(status).some((command) => /uninstall|logout/.test(command))).toBe(false);
  });

  test("denied is not presented as a purchase: the action is the existing account page", async () => {
    const status = await read(DENIED);
    const labels = status.access.actions.map((action) => action.label.toLowerCase());
    expect(labels.some((label) => /buy|purchase|upgrade|subscribe|price|trial/.test(label))).toBe(false);
    expect(commands(status)).toContain("https://console.openscout.app");
  });

  test("granted with nothing installed is 'Finish setting up', never 'no access'", async () => {
    const status = await read(GRANTED, { fullInstalled: false, native: APP_MISSING, served: SERVING_BASIC });
    expect(status.phase).toBe("finish_setup");
    expect(status.access.tier).toBe("solo_pro");
  });
});

describe("Solo Pro status: recovery paths", () => {
  test("missing credentials point at making and saving a download key", async () => {
    const status = await read({ state: "no_credential", checkedAt: NOW });
    expect(commands(status)).toEqual(expect.arrayContaining(["https://console.openscout.app/#downloads", "scout web login", "check_access"]));
  });

  test("a rejected key points at a new key, not at the account page", async () => {
    const status = await read({ state: "credential_rejected", checkedAt: NOW, keyWhere: "SCOUT_DIST_KEY" });
    expect(commands(status)).toEqual(expect.arrayContaining(["scout web login", "https://console.openscout.app/#downloads"]));
    expect(status.access.detail).toContain("doesn't say what the account has");
  });

  test("an unreachable host is retried and says installed parts keep working", async () => {
    const status = await read(UNKNOWN[3]!);
    expect(status.access.actions).toEqual([{ kind: "check_access", label: "Try again" }]);
    expect(status.access.detail).toContain("Nothing installed stops working");
  });

  test("an unchecked page asks to check and reads no key", async () => {
    const status = await read({ state: "unchecked" });
    expect(status.access).toMatchObject({ checkedAt: null, keyWhere: null, account: null });
    expect(status.access.actions).toEqual([{ kind: "check_access", label: "Check access" }]);
  });
});

describe("observeNativeApp: discovery, validity, running", () => {
  const HOME = "/Users/me";
  type Bundle = { id?: string | null; executable?: string | null; version?: string; executableOk?: boolean; plist?: boolean };

  function io(bundles: Record<string, Bundle>, processes: string[] | null = [], platform: NodeJS.Platform = "darwin"): NativeAppProbeIO {
    const plists = new Map<string, Bundle>();
    const executables = new Set<string>();
    for (const [path, bundle] of Object.entries(bundles)) {
      if (bundle.plist !== false) plists.set(`${path}/Contents/Info.plist`, bundle);
      const name = bundle.executable === undefined ? "Scout" : bundle.executable;
      if (name && bundle.executableOk !== false) executables.add(`${path}/Contents/MacOS/${name}`);
    }
    return {
      platform,
      home: HOME,
      exists: (path) => path in bundles || plists.has(path),
      isExecutableFile: (path) => executables.has(path),
      plistString: (plist, key) => {
        const bundle = plists.get(plist);
        if (!bundle) return null;
        if (key === "CFBundleIdentifier") return bundle.id === undefined ? "app.openscout.scout" : bundle.id;
        if (key === "CFBundleExecutable") return bundle.executable === undefined ? "Scout" : bundle.executable;
        if (key === "CFBundleShortVersionString") return bundle.version ?? "1.4.0";
        return null;
      },
      processExecutables: () => processes,
    };
  }

  test("finds Scout.app in /Applications", () => {
    expect(observeNativeApp(io({ "/Applications/Scout.app": {} }))).toMatchObject({ state: "installed", path: "/Applications/Scout.app", development: false });
  });

  test("finds a per-user install in ~/Applications", () => {
    expect(observeNativeApp(io({ [`${HOME}/Applications/Scout.app`]: {} }))).toMatchObject({ state: "installed", path: `${HOME}/Applications/Scout.app` });
  });

  test("finds the legacy OpenScout.app name", () => {
    const found = observeNativeApp(io({ "/Applications/OpenScout.app": { executable: "OpenScout", version: "0.2.100" } }));
    expect(found).toMatchObject({ state: "installed", path: "/Applications/OpenScout.app", version: "0.2.100" });
  });

  test("a bundle without a usable executable is damaged, and a valid one elsewhere still wins", () => {
    expect(observeNativeApp(io({ "/Applications/Scout.app": { executableOk: false } }))).toMatchObject({
      state: "damaged",
      path: "/Applications/Scout.app",
      problem: expect.stringContaining("not executable"),
    });
    expect(observeNativeApp(io({ "/Applications/Scout.app": { executableOk: false }, [`${HOME}/Applications/Scout.app`]: {} })))
      .toMatchObject({ state: "installed", path: `${HOME}/Applications/Scout.app` });
  });

  test("an empty folder named Scout.app, or a plist naming no executable, is damaged, not installed", () => {
    expect(observeNativeApp(io({ "/Applications/Scout.app": { plist: false } }))).toMatchObject({ state: "damaged", problem: "it has no Info.plist" });
    expect(observeNativeApp(io({ "/Applications/Scout.app": { executable: null } }))).toMatchObject({ state: "damaged" });
  });

  test("a different app that happens to be called Scout.app is not Scout", () => {
    expect(observeNativeApp(io({ "/Applications/Scout.app": { id: "com.example.scout" } }))).toMatchObject({
      state: "damaged",
      problem: expect.stringContaining("com.example.scout"),
    });
  });

  test("nothing found reports every place searched", () => {
    const found = observeNativeApp(io({}));
    expect(found).toEqual({
      state: "missing",
      searched: ["/Applications/Scout.app", `${HOME}/Applications/Scout.app`, "/Applications/OpenScout.app", `${HOME}/Applications/OpenScout.app`],
    });
  });

  test("running means the app's executable or its menu helper, not any process under the bundle", () => {
    const bundle = "/Applications/Scout.app";
    const unrelated = [`${bundle}/Contents/Resources/bin/some-tool`, `${bundle}/Contents/MacOS/ScoutHelperThatIsNotScout`];
    expect(observeNativeApp(io({ [bundle]: {} }, unrelated))).toMatchObject({ running: { app: false, menu: false } });
    expect(observeNativeApp(io({ [bundle]: {} }, [`${bundle}/Contents/MacOS/Scout`]))).toMatchObject({ running: { app: true, menu: false } });
    expect(observeNativeApp(io({ [bundle]: {} }, [`${bundle}/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu`])))
      .toMatchObject({ running: { app: false, menu: true } });
    expect(observeNativeApp(io({ [bundle]: {} }, null))).toMatchObject({ running: null });
  });

  test("a development build running from a checkout counts as installed", () => {
    const dev = "/Users/me/dev/openscout/apps/macos/dist/Scout.app";
    const found = observeNativeApp(io({ [dev]: {} }, [`${dev}/Contents/MacOS/Scout`]));
    expect(found).toMatchObject({ state: "installed", path: dev, development: true, running: { app: true, menu: false } });
  });

  test("a process path that merely looks like a dev bundle isn't trusted without a valid bundle", () => {
    const fake = "/tmp/x/Scout.app";
    expect(observeNativeApp(io({}, [`${fake}/Contents/MacOS/Scout`]))).toMatchObject({ state: "missing" });
  });

  test("off macOS it is not applicable", () => {
    expect(observeNativeApp(io({ "/Applications/Scout.app": {} }, [], "linux"))).toEqual({ state: "not_applicable" });
  });
});

describe("defaultSoloProProbes: physical installation of the full client", () => {
  test("an installed full client stays visible under OPENSCOUT_WEB_CLIENT_PROFILE=basic", () => {
    const support = mkdtempSync(join(tmpdir(), "solo-pro-support-"));
    try {
      const directory = join(support, "web", "full", VERSION);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      writeFileSync(join(directory, "scout-web-profile.json"), JSON.stringify({ profile: "full", version: VERSION }));
      const forcedBasic = defaultSoloProProbes({ env: { OPENSCOUT_WEB_CLIENT_PROFILE: "basic" }, supportDirectory: support });
      expect(forcedBasic.installedFullClient(VERSION)).toBe(directory);
      expect(forcedBasic.installedFullClient("9.9.9")).toBeNull();
    } finally {
      rmSync(support, { recursive: true, force: true });
    }
  });
});
