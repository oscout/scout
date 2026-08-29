import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const GITHUB_OWNER = "arach";
const GITHUB_REPO = "openscout";

const APP_NAME = "OpenScout.app";
const APP_PATH = `/Applications/${APP_NAME}`;
const INFO_PLIST_PATH = `${APP_PATH}/Contents/Info.plist`;
const APP_BUNDLE_ID = "app.openscout.scout";
const APP_PROCESS_NAME = "Scout";
const USER_AGENT = "scout-cli";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export type ScoutInstallOptions = {
  check: boolean;
  force: boolean;
  version: string | null;
  restart: boolean;
};

type GithubAsset = { name: string; browser_download_url: string; size: number };
type GithubRelease = { tag_name: string; name: string; assets: GithubAsset[] };

type ScoutInstallStatus =
  | "installed"
  | "updated"
  | "up-to-date"
  | "not-installed"
  | "update-available";

type ScoutInstallResult = {
  action: "install" | "check";
  status: ScoutInstallStatus;
  installed: string | null;
  target: string | null;
  bundlePath: string;
  message: string;
};

export function renderInstallCommandHelp(): string {
  return [
    "scout install — download and install the OpenScout macOS app",
    "",
    "Usage:",
    "  scout install                 # install or update to the latest signed release",
    "  scout install --check         # report installed vs latest, install nothing",
    "  scout install --version <tag> # install a specific release (e.g. v0.2.70)",
    "  scout install --force         # reinstall even if already up to date",
    "  scout install --no-restart    # do not relaunch OpenScout after installing",
    "",
    "Behavior:",
    "  Downloads the signed + notarized OpenScout.dmg from the GitHub release,",
    "  installs OpenScout.app (which embeds the menu bar helper) to /Applications,",
    "  and clears the Gatekeeper quarantine flag so it opens cleanly.",
    "",
    "  The app drives the bundled local runtime from the global scout CLI, so",
    "  `bun add -g @openscout/scout` is the companion install for the command line.",
  ].join("\n");
}

export function parseInstallArgs(args: string[]): ScoutInstallOptions {
  const options: ScoutInstallOptions = {
    check: false,
    force: false,
    version: null,
    restart: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      // Global flag is handled by the argv parser; tolerate a stray pass-through.
      continue;
    }
    if (arg === "check" || arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--force" || arg === "-f") {
      options.force = true;
      continue;
    }
    if (arg === "--no-restart") {
      options.restart = false;
      continue;
    }
    if (arg === "--version" || arg === "--tag") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new ScoutCliError(`${arg} requires a release tag (e.g. ${arg} v0.2.70)`);
      }
      options.version = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }
    if (arg.startsWith("--tag=")) {
      options.version = arg.slice("--tag=".length);
      continue;
    }
    throw new ScoutCliError(`unknown option for install: ${arg} (try: scout install --help)`);
  }

  return options;
}

function stripLeadingV(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "unknown size";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getInstalledVersion(): string | null {
  if (!existsSync(INFO_PLIST_PATH)) return null;
  const result = spawnSync(
    "defaults",
    ["read", INFO_PLIST_PATH, "CFBundleShortVersionString"],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) return null;
  const version = result.stdout.trim();
  return version || null;
}

async function fetchRelease(version: string | null): Promise<GithubRelease> {
  const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
  const apiUrl = version ? `${base}/tags/${version}` : `${base}/latest`;

  // Unauthenticated fetch first (60 req/hr is plenty for an install).
  try {
    const response = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
    });
    if (response.ok) {
      return (await response.json()) as GithubRelease;
    }
  } catch {
    // Fall through to the gh CLI fallback.
  }

  // Fallback: gh CLI, which uses the user's token and higher rate limits.
  const apiPath = version
    ? `repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${version}`
    : `repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const gh = spawnSync("gh", ["api", apiPath], { encoding: "utf8" });
  if ((gh.status ?? 1) === 0 && gh.stdout.trim()) {
    return JSON.parse(gh.stdout) as GithubRelease;
  }

  throw new ScoutCliError(
    version
      ? `release "${version}" not found on GitHub (${GITHUB_OWNER}/${GITHUB_REPO})`
      : `could not fetch the latest OpenScout release from GitHub (${GITHUB_OWNER}/${GITHUB_REPO})`,
  );
}

/**
 * Pick the product DMG (OpenScout.app, which embeds the menu helper), never the
 * standalone OpenScoutMenu DMG. Prefer the versioned asset, then the latest alias.
 */
export function findAppDmgAsset(release: GithubRelease): GithubAsset {
  const assets = release.assets ?? [];
  const isMenuOnly = (name: string) => name.toLowerCase().startsWith("openscoutmenu");
  const isDmg = (name: string) => name.toLowerCase().endsWith(".dmg");

  const versioned = assets.find(
    (asset) => /^openscout-\d/i.test(asset.name) && isDmg(asset.name) && !isMenuOnly(asset.name),
  );
  if (versioned) return versioned;

  const latestAlias = assets.find((asset) => asset.name.toLowerCase() === "openscout.dmg");
  if (latestAlias) return latestAlias;

  const anyProductDmg = assets.find((asset) => isDmg(asset.name) && !isMenuOnly(asset.name));
  if (anyProductDmg) return anyProductDmg;

  throw new ScoutCliError(
    `no OpenScout.app DMG found in release ${release.tag_name}. Assets: ${
      assets.map((asset) => asset.name).join(", ") || "(none)"
    }`,
  );
}

async function downloadDmg(asset: GithubAsset, destination: string, context: ScoutCommandContext): Promise<void> {
  context.stderr(`Downloading ${asset.name} (${formatBytes(asset.size)})…`);
  const response = await fetch(asset.browser_download_url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new ScoutCliError(`download failed: HTTP ${response.status} for ${asset.browser_download_url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new ScoutCliError("download failed: empty response body");
  }
  writeFileSync(destination, buffer);
}

function mountDmg(dmgPath: string): string {
  const result = spawnSync(
    "hdiutil",
    ["attach", dmgPath, "-nobrowse", "-noverify", "-noautoopen", "-plist"],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new ScoutCliError(
      `could not mount ${dmgPath}: ${result.stderr.trim() || "hdiutil attach failed"}`,
    );
  }

  const mountPointMatch = result.stdout.match(
    /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/,
  );
  if (mountPointMatch) {
    return mountPointMatch[1];
  }

  throw new ScoutCliError("could not determine the DMG mount point");
}

function unmountDmg(mountPoint: string): void {
  spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { encoding: "utf8" });
}

function copyAppFromMount(mountPoint: string): void {
  const listing = spawnSync("ls", [mountPoint], { encoding: "utf8" });
  const appEntry = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line === APP_NAME) ??
    listing.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(".app") && !line.toLowerCase().startsWith("openscoutmenu"));

  if (!appEntry) {
    throw new ScoutCliError(`no ${APP_NAME} found in the mounted DMG at ${mountPoint}`);
  }

  const source = join(mountPoint, appEntry);

  if (existsSync(APP_PATH)) {
    const removed = spawnSync("rm", ["-rf", APP_PATH], { encoding: "utf8" });
    if ((removed.status ?? 1) !== 0) {
      throw new ScoutCliError(
        `could not replace ${APP_PATH} (permission denied?). Try: sudo scout install`,
      );
    }
  }

  const copied = spawnSync("cp", ["-R", source, APP_PATH], { encoding: "utf8" });
  if ((copied.status ?? 1) !== 0) {
    throw new ScoutCliError(
      `could not copy the app to ${APP_PATH}: ${copied.stderr.trim() || "permission denied?"}. Try: sudo scout install`,
    );
  }
}

function removeQuarantine(): void {
  // Non-fatal: a signed + notarized app opens regardless, but clearing the flag
  // avoids the first-launch prompt for locally-relocated bundles.
  spawnSync("xattr", ["-rd", "com.apple.quarantine", APP_PATH], { encoding: "utf8" });
}

function isAppRunning(): boolean {
  return (spawnSync("pgrep", ["-x", APP_PROCESS_NAME], { encoding: "utf8" }).status ?? 1) === 0;
}

function quitApp(): void {
  spawnSync("osascript", ["-e", `tell application id "${APP_BUNDLE_ID}" to quit`], {
    encoding: "utf8",
  });
}

function launchApp(): void {
  const byId = spawnSync("open", ["-b", APP_BUNDLE_ID], { encoding: "utf8" });
  if ((byId.status ?? 1) !== 0) {
    spawnSync("open", [APP_PATH], { encoding: "utf8" });
  }
}

function renderInstallResult(result: ScoutInstallResult): string {
  if (result.action === "check") {
    const lines = [
      `Installed: ${result.installed ?? "not installed"}`,
      `Latest:    ${result.target ?? "unknown"}`,
    ];
    lines.push(result.message);
    return lines.join("\n");
  }
  return result.message;
}

async function runCheck(context: ScoutCommandContext, options: ScoutInstallOptions): Promise<void> {
  const installed = getInstalledVersion();
  const release = await fetchRelease(options.version);
  const target = stripLeadingV(release.tag_name);

  let status: ScoutInstallStatus;
  let message: string;
  if (!installed) {
    status = "not-installed";
    message = "OpenScout is not installed — run `scout install`.";
  } else if (installed === target) {
    status = "up-to-date";
    message = `OpenScout ${installed} is up to date.`;
  } else {
    status = "update-available";
    message = `Update available: ${installed} → ${target}. Run \`scout install\`.`;
  }

  context.output.writeValue(
    { action: "check", status, installed, target, bundlePath: APP_PATH, message },
    renderInstallResult,
  );
}

export async function runInstallCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (HELP_FLAGS.has(args[0] ?? "")) {
    context.output.writeText(renderInstallCommandHelp());
    return;
  }

  if (process.platform !== "darwin") {
    throw new ScoutCliError("scout install is only supported on macOS.");
  }

  const options = parseInstallArgs(args);

  if (options.check) {
    await runCheck(context, options);
    return;
  }

  const installedBefore = getInstalledVersion();
  context.stderr(options.version ? `Fetching release ${options.version}…` : "Fetching the latest OpenScout release…");
  const release = await fetchRelease(options.version);
  const target = stripLeadingV(release.tag_name);

  if (!options.force && installedBefore && installedBefore === target) {
    context.output.writeValue(
      {
        action: "install",
        status: "up-to-date",
        installed: installedBefore,
        target,
        bundlePath: APP_PATH,
        message: `OpenScout ${target} is already installed (use --force to reinstall).`,
      } satisfies ScoutInstallResult,
      renderInstallResult,
    );
    return;
  }

  const asset = findAppDmgAsset(release);
  const wasRunning = isAppRunning();

  const workDir = mkdtempSync(join(tmpdir(), "scout-install-"));
  const dmgPath = join(workDir, asset.name);
  let mountPoint: string | null = null;
  try {
    await downloadDmg(asset, dmgPath, context);
    context.stderr(`Installing OpenScout ${target} to ${APP_PATH}…`);
    mountPoint = mountDmg(dmgPath);
    copyAppFromMount(mountPoint);
  } finally {
    if (mountPoint) unmountDmg(mountPoint);
    rmSync(workDir, { recursive: true, force: true });
  }

  removeQuarantine();

  if (wasRunning && options.restart) {
    quitApp();
    launchApp();
  }

  const installedAfter = getInstalledVersion() ?? target;
  const status: ScoutInstallStatus = installedBefore ? "updated" : "installed";
  const relaunchNote = wasRunning
    ? options.restart
      ? " (relaunched)"
      : " (restart OpenScout to use the new version)"
    : "";
  const verb = installedBefore ? `Updated ${installedBefore} →` : "Installed";

  context.output.writeValue(
    {
      action: "install",
      status,
      installed: installedAfter,
      target,
      bundlePath: APP_PATH,
      message: `${verb} OpenScout ${installedAfter} → ${APP_PATH}${relaunchNote}`,
    } satisfies ScoutInstallResult,
    renderInstallResult,
  );
}
