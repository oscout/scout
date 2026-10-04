// Solo Pro, as three separate facts about this machine:
//
//   access     what the download host last said about the account's full web
//              app (Solo Pro is that access; there is no other Pro policy)
//   installed  which Pro components are actually on disk
//   ready      whether the installed ones are serving or running right now
//
// Reading the status is local only: files, `plutil`, `ps`, `which` and the
// herdr session probe. It never asks the network. Access comes from an explicit
// check (`checkExpandedWebAccess`) that the caller caches; until one runs,
// access is "unchecked", and an unconfirmed answer never becomes a yes or a no.
// Nothing here installs, writes account state, or reads the download key.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { SCOUT_DIST_KEYS_URL, type ExpandedWebAccess } from "./dist-access.js";
import { isHerdrAvailable, readHerdrSessions } from "./system-probes/herdr.js";
import { resolveInstalledWebFullClient, webFullClientsDirectory } from "./web-full-client.js";

export const HERDR_INSTALL_URL = "https://herdr.dev/docs/install/";
export const SCOUT_ACCOUNT_URL = "https://console.openscout.app";

export type SoloProAction =
  | { kind: "command"; label: string; command: string }
  | { kind: "link"; label: string; href: string }
  /** Re-runs the explicit access check; the only action the page performs itself. */
  | { kind: "check_access"; label: string };

export type SoloProAccessSummary = {
  state: ExpandedWebAccess["state"];
  /** true only for an answer from the download host, never for unknown. */
  confirmed: boolean;
  /** "solo_pro" only when the host confirmed the full web app. */
  tier: "solo_pro" | "solo" | null;
  title: string;
  detail: string;
  checkedAt: number | null;
  keyWhere: string | null;
  account: { login: string; label: string | null } | null;
  actions: SoloProAction[];
};

export type SoloProComponentId = "full_web_app" | "native_app" | "herdr";

export type SoloProComponent = {
  id: SoloProComponentId;
  label: string;
  /** Required for "Solo Pro is set up"; optional parts never block it. */
  required: boolean;
  installed: "installed" | "missing" | "not_applicable" | "unknown";
  installedDetail: string;
  ready: "ready" | "not_ready" | "not_applicable" | "unknown";
  readyDetail: string;
  actions: SoloProAction[];
};

export type SoloProPhase =
  /** Confirmed access, required parts installed and ready. */
  | "active"
  /** Confirmed access, a required part is not installed. */
  | "finish_setup"
  /** Confirmed access, the full web app installed but not the one being served. */
  | "not_ready"
  /** The host said this account doesn't have the full web app. */
  | "no_access"
  /** Access is unknown: never checked, no key, key refused, or host unreachable. */
  | "unconfirmed";

export type SoloProStatus = {
  generatedAt: number;
  scoutVersion: string | null;
  /** The platform the installed/ready facts describe. */
  platform: NodeJS.Platform;
  phase: SoloProPhase;
  headline: string;
  access: SoloProAccessSummary;
  components: SoloProComponent[];
};

/* ── probes ─────────────────────────────────────────────────────────────── */

export type NativeAppObservation =
  | { state: "not_applicable" }
  /** No candidate bundle exists. */
  | { state: "missing"; searched: string[] }
  /** A bundle exists at a supported location but can't run: no Info.plist, no executable, or not Scout. */
  | { state: "damaged"; path: string; problem: string }
  | {
      state: "installed";
      path: string;
      version: string | null;
      /** Found only because it is running from outside the supported locations (a development build). */
      development: boolean;
      /** The app's own executable or its embedded menu helper is running; null when `ps` can't answer. */
      running: { app: boolean; menu: boolean } | null;
    };

export type SoloProProbes = {
  platform: NodeJS.Platform;
  /**
   * The full client physically installed for this exact version, or null. This
   * is installation, not selection: OPENSCOUT_WEB_CLIENT_PROFILE=basic doesn't
   * hide it.
   */
  installedFullClient(version: string | null): string | null;
  /** Versions with a full client under the support directory. */
  installedFullClientVersions(): string[];
  nativeApp(): NativeAppObservation;
  herdrInstalled(): Promise<boolean>;
  /** Running herdr sessions; null when the probe failed. */
  herdrRunningSessions(): Promise<number | null>;
};

export type SoloProServedClient = {
  /** The profile the web server is serving: from its static root, or full for a dev proxy. */
  profile: "basic" | "full";
  /** The static root, to tell an installed full client from a source or custom build. */
  root: string | null;
};

/* ── native app discovery ───────────────────────────────────────────────── */

export const SCOUT_APP_BUNDLE_ID = "app.openscout.scout";
/** Scout.app since 0.2.106; OpenScout.app before it. The same names and folders `scout menu` searches. */
export const SCOUT_APP_BUNDLE_NAMES = ["Scout.app", "OpenScout.app"] as const;
const EMBEDDED_MENU_EXECUTABLE = join("Contents", "Library", "LoginItems", "ScoutMenu.app", "Contents", "MacOS", "ScoutMenu");
const DEVELOPMENT_APP_EXECUTABLE = /^(\/.+\/(?:Scout|OpenScout)\.app)\/Contents\/MacOS\/[^/]+$/;

export type NativeAppProbeIO = {
  platform: NodeJS.Platform;
  home: string;
  exists(path: string): boolean;
  isExecutableFile(path: string): boolean;
  plistString(plistPath: string, key: string): string | null;
  /** Full executable paths of running processes (`ps -axo comm=`), or null when `ps` can't answer. */
  processExecutables(): string[] | null;
};

export function scoutAppCandidatePaths(home: string): string[] {
  return SCOUT_APP_BUNDLE_NAMES.flatMap((name) => [join("/Applications", name), join(home, "Applications", name)]);
}

type BundleCheck = { ok: true; executable: string; version: string | null } | { ok: false; problem: string };

function checkBundle(io: NativeAppProbeIO, bundle: string): BundleCheck {
  const plist = join(bundle, "Contents", "Info.plist");
  if (!io.exists(plist)) return { ok: false, problem: "it has no Info.plist" };
  const id = io.plistString(plist, "CFBundleIdentifier");
  if (id !== null && id !== SCOUT_APP_BUNDLE_ID) return { ok: false, problem: `its bundle id is ${id}, not ${SCOUT_APP_BUNDLE_ID}` };
  const name = io.plistString(plist, "CFBundleExecutable");
  if (!name) return { ok: false, problem: "its Info.plist names no executable" };
  const executable = join(bundle, "Contents", "MacOS", name);
  if (!io.isExecutableFile(executable)) return { ok: false, problem: `${join("Contents", "MacOS", name)} is missing or not executable` };
  return { ok: true, executable, version: io.plistString(plist, "CFBundleShortVersionString") };
}

/**
 * Finds Scout for Mac the way `scout menu` does (Scout.app, then the legacy
 * OpenScout.app, in /Applications and ~/Applications), keeps only a bundle that
 * can actually launch, and reports running only for its own executable or its
 * embedded menu helper, never for some other process that lives under the
 * bundle path. A development build running from a checkout counts as installed.
 */
export function observeNativeApp(io: NativeAppProbeIO): NativeAppObservation {
  if (io.platform !== "darwin") return { state: "not_applicable" };
  const processes = io.processExecutables();
  const running = (bundle: string, executable: string) => processes === null
    ? null
    : { app: processes.includes(executable), menu: processes.includes(join(bundle, EMBEDDED_MENU_EXECUTABLE)) };

  const searched = scoutAppCandidatePaths(io.home);
  let damaged: { path: string; problem: string } | null = null;
  for (const bundle of searched) {
    if (!io.exists(bundle)) continue;
    const check = checkBundle(io, bundle);
    if (check.ok) {
      return { state: "installed", path: bundle, version: check.version, development: false, running: running(bundle, check.executable) };
    }
    damaged ??= { path: bundle, problem: check.problem };
  }
  for (const executable of processes ?? []) {
    const bundle = executable.match(DEVELOPMENT_APP_EXECUTABLE)?.[1];
    if (!bundle || searched.includes(bundle)) continue;
    const check = checkBundle(io, bundle);
    if (check.ok && check.executable === executable) {
      return { state: "installed", path: bundle, version: check.version, development: true, running: running(bundle, check.executable) };
    }
  }
  return damaged ? { state: "damaged", ...damaged } : { state: "missing", searched };
}

export function defaultSoloProProbes(options: { env?: NodeJS.ProcessEnv; supportDirectory?: string } = {}): SoloProProbes {
  const env = options.env ?? process.env;
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 });
    return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "" };
  };
  const io: NativeAppProbeIO = {
    platform: process.platform,
    home: env.HOME?.trim() || homedir(),
    exists: (path) => existsSync(path),
    isExecutableFile: (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    plistString: (plistPath, key) => {
      const result = run("plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
      return result.ok ? result.stdout.trim() || null : null;
    },
    processExecutables: () => {
      const result = run("ps", ["-axo", "comm="]);
      return result.ok ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : null;
    },
  };
  return {
    platform: process.platform,
    // Physical installation for this version. The serving opt-out is passed
    // separately, so it never makes an installed client look missing.
    installedFullClient: (version) => resolveInstalledWebFullClient(version, { env: {}, supportDirectory: options.supportDirectory }),
    installedFullClientVersions: () => {
      try {
        return readdirSync(webFullClientsDirectory(options.supportDirectory)).filter((entry) => !entry.startsWith("."));
      } catch {
        return [];
      }
    },
    nativeApp: () => observeNativeApp(io),
    herdrInstalled: () => isHerdrAvailable({ env }),
    herdrRunningSessions: async () => {
      try {
        return (await readHerdrSessions({ env })).filter((session) => session.running).length;
      } catch {
        return null;
      }
    },
  };
}

/* ── access ─────────────────────────────────────────────────────────────── */

const LOGIN: SoloProAction = { kind: "command", label: "Save a download key", command: "scout web login" };
const MAKE_KEY: SoloProAction = { kind: "link", label: "Make a download key", href: SCOUT_DIST_KEYS_URL };
const CHECK: SoloProAction = { kind: "check_access", label: "Check access" };

export function summarizeSoloProAccess(access: ExpandedWebAccess): SoloProAccessSummary {
  const base = {
    state: access.state,
    checkedAt: access.state === "unchecked" ? null : access.checkedAt,
    keyWhere: "keyWhere" in access ? access.keyWhere : null,
    account: access.state === "granted" ? access.account : null,
  };
  switch (access.state) {
    case "granted":
      return {
        ...base,
        confirmed: true,
        tier: "solo_pro",
        title: "Solo Pro",
        detail: `${access.account.login} has the full web app.`,
        actions: [CHECK],
      };
    case "denied":
      return {
        ...base,
        confirmed: true,
        tier: "solo",
        title: "Solo",
        detail: "The download host says this account doesn't have the full web app. Your account page shows what it includes.",
        actions: [{ kind: "link", label: "See your account", href: SCOUT_ACCOUNT_URL }, CHECK],
      };
    case "no_credential":
      return {
        ...base,
        confirmed: false,
        tier: null,
        title: "Not confirmed",
        detail: "No download key is saved on this machine, so Scout can't ask which plan this account has.",
        actions: [MAKE_KEY, LOGIN, CHECK],
      };
    case "credential_rejected":
      return {
        ...base,
        confirmed: false,
        tier: null,
        title: "Not confirmed",
        detail: "The saved download key was not accepted. It may have been revoked. This doesn't say what the account has.",
        actions: [MAKE_KEY, LOGIN, CHECK],
      };
    case "unavailable":
      return {
        ...base,
        confirmed: false,
        tier: null,
        title: "Not confirmed",
        detail: `Scout couldn't get an answer: ${access.reason} Nothing installed stops working.`,
        actions: [{ ...CHECK, label: "Try again" }],
      };
    case "unchecked":
      return {
        ...base,
        confirmed: false,
        tier: null,
        title: "Not checked",
        detail: "Scout asks the download host only when you check. Nothing installed is used as evidence either way.",
        actions: [CHECK],
      };
  }
}

/* ── components ─────────────────────────────────────────────────────────── */

function fullWebAppComponent(
  probes: SoloProProbes,
  version: string | null,
  served: SoloProServedClient,
  env: NodeJS.ProcessEnv,
): SoloProComponent {
  const label = "Full web app";
  const base = { id: "full_web_app" as const, label, required: true };
  const install: SoloProAction = { kind: "command", label: "Install the full web app", command: "scout web install" };
  const restart: SoloProAction = { kind: "command", label: "Restart the web server", command: "scout server restart" };
  // Selection, not installation: the server was told to serve basic.
  const optedOut = env.OPENSCOUT_WEB_CLIENT_PROFILE?.trim() === "basic";
  const optedOutDetail = "OPENSCOUT_WEB_CLIENT_PROFILE=basic tells this server to serve the basic web app.";
  const installed = probes.installedFullClient(version);

  if (installed) {
    const serving = served.profile === "full" && served.root !== null && resolve(served.root) === resolve(installed);
    return {
      ...base,
      installed: "installed",
      installedDetail: `Version ${version}.`,
      ready: serving ? "ready" : "not_ready",
      readyDetail: serving
        ? "This web server is serving it."
        : optedOut
          ? `Installed, but ${optedOutDetail}`
          : "Installed, but this web server started before it and still serves the previous client.",
      // Unsetting the opt-out is the operator's call; a restart alone won't change it.
      actions: serving || optedOut ? [] : [restart],
    };
  }
  if (served.profile === "full") {
    // A source checkout, a dev proxy, or OPENSCOUT_WEB_STATIC_ROOT: full, but
    // not something `scout web install` put here.
    return {
      ...base,
      installed: "installed",
      installedDetail: "Served by this build or OPENSCOUT_WEB_STATIC_ROOT, not by scout web install.",
      ready: "ready",
      readyDetail: "This web server is serving it.",
      actions: [],
    };
  }
  const others = probes.installedFullClientVersions().filter((entry) => entry !== version);
  return {
    ...base,
    installed: "missing",
    installedDetail: others.length > 0 && version
      ? `Installed for ${others.join(", ")}, not for this Scout (${version}).`
      : "Not installed. This server serves the basic web app (Home, DMs, Tail).",
    ready: "not_ready",
    readyDetail: optedOut ? optedOutDetail : "This server serves the basic web app.",
    actions: [install],
  };
}

// Optional: Solo Pro is the full web app. Scout for Mac is reported on its own
// and never decides whether Solo Pro is set up.
function nativeAppComponent(probes: SoloProProbes): SoloProComponent {
  const base = { id: "native_app" as const, label: "Scout for Mac", required: false };
  const install: SoloProAction = { kind: "command", label: "Install Scout for Mac", command: "scout install" };
  const app = probes.nativeApp();
  switch (app.state) {
    case "not_applicable":
      return {
        ...base,
        installed: "not_applicable",
        installedDetail: "Only on macOS.",
        ready: "not_applicable",
        readyDetail: "Only on macOS.",
        actions: [],
      };
    case "missing":
      return {
        ...base,
        installed: "missing",
        installedDetail: "Not in /Applications or ~/Applications.",
        ready: "not_ready",
        readyDetail: "Not installed.",
        actions: [install],
      };
    case "damaged":
      return {
        ...base,
        installed: "unknown",
        installedDetail: `${app.path} is there, but ${app.problem}. scout install replaces it.`,
        ready: "not_ready",
        readyDetail: "It can't be opened as it is.",
        actions: [install],
      };
    case "installed": {
      const version = app.version ? `, version ${app.version}` : "";
      const running = app.running;
      const live = running !== null && (running.app || running.menu);
      return {
        ...base,
        installed: "installed",
        installedDetail: app.development ? `Development build at ${app.path}${version}.` : `${app.path}${version}.`,
        ready: running === null ? "unknown" : live ? "ready" : "not_ready",
        readyDetail: running === null
          ? "Couldn't list running processes."
          : running.app && running.menu
            ? "The app and its menu bar helper are running."
            : running.app
              ? "The app is running."
              : running.menu
                ? "The menu bar helper is running."
                : "Installed but not running. The web app doesn't need it.",
        actions: running && !live ? [{ kind: "command", label: "Open the menu bar app", command: "scout menu" }] : [],
      };
    }
  }
}

async function herdrComponent(probes: SoloProProbes): Promise<SoloProComponent> {
  const base = { id: "herdr" as const, label: "Herdr", required: false };
  if (!(await probes.herdrInstalled())) {
    return {
      ...base,
      installed: "missing",
      installedDetail: "Not found on PATH. Optional: terminal workspaces use it.",
      ready: "not_ready",
      readyDetail: "Not installed.",
      actions: [{ kind: "link", label: "Install Herdr", href: HERDR_INSTALL_URL }],
    };
  }
  const running = await probes.herdrRunningSessions();
  return {
    ...base,
    installed: "installed",
    installedDetail: "Found on PATH.",
    ready: running === null ? "unknown" : running > 0 ? "ready" : "not_ready",
    readyDetail: running === null
      ? "Couldn't read herdr sessions."
      : running > 0
        ? `${running} session${running === 1 ? "" : "s"} running.`
        : "No herdr session is running.",
    actions: running === 0 ? [{ kind: "command", label: "Start a herdr server", command: "herdr server" }] : [],
  };
}

/* ── status ─────────────────────────────────────────────────────────────── */

export function soloProPhase(access: SoloProAccessSummary, components: SoloProComponent[]): SoloProPhase {
  if (access.state === "denied") return "no_access";
  if (access.state !== "granted") return "unconfirmed";
  const required = components.filter((component) => component.required);
  if (required.some((component) => component.installed !== "installed")) return "finish_setup";
  if (required.some((component) => component.ready !== "ready")) return "not_ready";
  return "active";
}

const HEADLINES: Record<SoloProPhase, string> = {
  active: "Solo Pro is set up on this machine",
  finish_setup: "Finish setting up Solo Pro",
  not_ready: "Solo Pro is installed but not being served yet",
  no_access: "This account doesn't have Solo Pro",
  unconfirmed: "Solo Pro access isn't confirmed",
};

export async function readSoloProStatus(options: {
  access: ExpandedWebAccess;
  scoutVersion: string | null;
  served: SoloProServedClient;
  probes: SoloProProbes;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<SoloProStatus> {
  const env = options.env ?? process.env;
  const access = summarizeSoloProAccess(options.access);
  const components = [
    fullWebAppComponent(options.probes, options.scoutVersion, options.served, env),
    nativeAppComponent(options.probes),
    await herdrComponent(options.probes),
  ];
  const phase = soloProPhase(access, components);
  return {
    generatedAt: (options.now ?? Date.now)(),
    platform: options.probes.platform,
    scoutVersion: options.scoutVersion,
    phase,
    headline: HEADLINES[phase],
    access,
    components,
  };
}
