import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const GITHUB_OWNER = "oscout";
const GITHUB_REPO = "scout";

const APP_NAME = "OpenScout.app";
const APP_PATH = `/Applications/${APP_NAME}`;
const INFO_PLIST_PATH = `${APP_PATH}/Contents/Info.plist`;
const APP_BUNDLE_ID = "app.openscout.scout";
const HELPER_BUNDLE_ID = "app.openscout.scout.menu";
const APP_PROCESS_NAME = "Scout";
const USER_AGENT = "scout-cli";
const EXPECTED_TEAM_ID = "2U83JFPW66";
const MINIMUM_MACOS_MAJOR = 26;
const MINIMUM_MACOS_VERSION = "26.0";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export type ScoutInstallOptions = {
  check: boolean;
  force: boolean;
  version: string | null;
  restart: boolean;
};

type GithubAsset = { name: string; browser_download_url: string; size: number };
type GithubRelease = {
  tag_name: string;
  name: string;
  assets: GithubAsset[];
  draft?: boolean;
  prerelease?: boolean;
};

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
    "  scout install --version <tag> # install a specific app release (e.g. app-v0.2.92)",
    "  scout install --force         # reinstall even if already up to date",
    "  scout install --no-restart    # do not relaunch OpenScout after installing",
    "",
    "Behavior:",
    "  Requires macOS 26 or later on Apple silicon.",
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
        throw new ScoutCliError(`${arg} requires an app release tag (e.g. ${arg} app-v0.2.92)`);
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

export function appVersionFromReleaseTag(tag: string): string {
  const match = tag.trim().match(/^app-v(\d+\.\d+\.\d+)$/);
  if (!match) {
    throw new ScoutCliError(`invalid OpenScout app release tag: ${tag}`);
  }
  return match[1];
}

function normalizeRequestedAppTag(value: string): string {
  const trimmed = value.trim();
  if (/^app-v\d+\.\d+\.\d+$/.test(trimmed)) return trimmed;
  if (/^v?\d+\.\d+\.\d+$/.test(trimmed)) return `app-v${trimmed.replace(/^v/, "")}`;
  throw new ScoutCliError(`invalid OpenScout app version: ${value}`);
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
  const requestedTag = version ? normalizeRequestedAppTag(version) : null;
  const apiUrl = requestedTag ? `${base}/tags/${requestedTag}` : `${base}?per_page=100`;

  // Unauthenticated fetch first (60 req/hr is plenty for an install).
  try {
    const response = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
    });
    if (response.ok) {
      const payload = await response.json();
      return requestedTag
        ? assertPublishedAppRelease(payload as GithubRelease, requestedTag)
        : selectLatestAppRelease(payload as GithubRelease[]);
    }
  } catch {
    // Fall through to the gh CLI fallback.
  }

  // Fallback: gh CLI, which uses the user's token and higher rate limits.
  const apiPath = requestedTag
    ? `repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${requestedTag}`
    : `repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`;
  const gh = spawnSync("gh", ["api", apiPath], { encoding: "utf8" });
  if ((gh.status ?? 1) === 0 && gh.stdout.trim()) {
    const payload = JSON.parse(gh.stdout);
    return requestedTag
      ? assertPublishedAppRelease(payload as GithubRelease, requestedTag)
      : selectLatestAppRelease(payload as GithubRelease[]);
  }

  throw new ScoutCliError(
    version
      ? `app release "${requestedTag}" not found on GitHub (${GITHUB_OWNER}/${GITHUB_REPO})`
      : `could not fetch the latest OpenScout release from GitHub (${GITHUB_OWNER}/${GITHUB_REPO})`,
  );
}

function compareAppReleaseVersions(left: GithubRelease, right: GithubRelease): number {
  const leftParts = appVersionFromReleaseTag(left.tag_name).split(".").map(Number);
  const rightParts = appVersionFromReleaseTag(right.tag_name).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function assertPublishedAppRelease(
  release: GithubRelease,
  expectedTag?: string,
): GithubRelease {
  if (expectedTag && release.tag_name !== expectedTag) {
    throw new ScoutCliError(
      `GitHub returned app release ${release.tag_name || "<missing>"}; expected ${expectedTag}`,
    );
  }
  if (release.draft || release.prerelease) {
    throw new ScoutCliError(`app release ${release.tag_name} is not a published stable release`);
  }
  findAppDmgAsset(release);
  return release;
}

/**
 * Pick the product DMG (OpenScout.app, which embeds the menu helper), never the
 * standalone OpenScoutMenu DMG. App release assets are immutable and versioned.
 */
export function findAppDmgAsset(release: GithubRelease): GithubAsset {
  const assets = release.assets ?? [];
  const version = appVersionFromReleaseTag(release.tag_name);
  const expectedName = `OpenScout-${version}.dmg`;
  const exact = assets.find((asset) => asset.name === expectedName);
  if (exact) return exact;

  throw new ScoutCliError(
    `immutable ${expectedName} not found in app release ${release.tag_name}. Assets: ${
      assets.map((asset) => asset.name).join(", ") || "(none)"
    }`,
  );
}

export function selectLatestAppRelease(releases: GithubRelease[]): GithubRelease {
  const candidates = releases.filter((candidate) => {
    if (candidate.draft || candidate.prerelease) return false;
    if (!/^app-v\d+\.\d+\.\d+$/.test(candidate.tag_name)) return false;
    try {
      findAppDmgAsset(candidate);
      return true;
    } catch {
      return false;
    }
  });
  candidates.sort(compareAppReleaseVersions);
  const release = candidates[0];
  if (!release) {
    throw new ScoutCliError(
      `no published app-v* release with an immutable OpenScout DMG found on GitHub (${GITHUB_OWNER}/${GITHUB_REPO})`,
    );
  }
  return release;
}

async function downloadDmg(asset: GithubAsset, destination: string, context: ScoutCommandContext): Promise<void> {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new ScoutCliError(`release asset ${asset.name} has an invalid reported size: ${asset.size}`);
  }
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
  if (buffer.length !== asset.size) {
    throw new ScoutCliError(
      `download failed: ${asset.name} is ${buffer.length} bytes; GitHub reported ${asset.size}`,
    );
  }
  writeFileSync(destination, buffer);
}

function commandOutput(command: string, args: string[], label: string): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if ((result.status ?? 1) !== 0) {
    throw new ScoutCliError(`${label} failed: ${output.trim() || `${command} exited ${result.status}`}`);
  }
  return output;
}

function verifyDeveloperIdSignature(codePath: string, label: string): void {
  commandOutput("codesign", ["--verify", "--deep", "--strict", "--verbose=2", codePath], `${label} signature`);
  const details = commandOutput("codesign", ["-dvvv", codePath], `${label} signature details`);
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const authority = details.match(/^Authority=(Developer ID Application:.+)$/m)?.[1]?.trim();
  if (team !== EXPECTED_TEAM_ID || !authority?.endsWith(`(${EXPECTED_TEAM_ID})`)) {
    throw new ScoutCliError(
      `${label} is not signed by OpenScout's Developer ID Application team ${EXPECTED_TEAM_ID}`,
    );
  }
}

function plistValue(plistPath: string, key: string): string {
  return commandOutput(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plistPath],
    `read ${key}`,
  ).trim();
}

function verifyDmg(dmgPath: string): void {
  verifyDeveloperIdSignature(dmgPath, "OpenScout DMG");
  commandOutput("xcrun", ["stapler", "validate", dmgPath], "DMG notarization ticket");
  commandOutput(
    "spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmgPath],
    "DMG Gatekeeper assessment",
  );
}

function verifyAppBundle(appPath: string, expectedVersion: string): void {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  if (plistValue(infoPlist, "CFBundleIdentifier") !== APP_BUNDLE_ID) {
    throw new ScoutCliError(`mounted app bundle identifier is not ${APP_BUNDLE_ID}`);
  }
  if (plistValue(infoPlist, "CFBundleShortVersionString") !== expectedVersion) {
    throw new ScoutCliError(`mounted app version is not ${expectedVersion}`);
  }
  if (plistValue(infoPlist, "LSMinimumSystemVersion") !== MINIMUM_MACOS_VERSION) {
    throw new ScoutCliError(`mounted app does not require macOS ${MINIMUM_MACOS_VERSION}`);
  }
  verifyDeveloperIdSignature(appPath, "OpenScout.app");

  const helperPath = join(appPath, "Contents", "Library", "LoginItems", "ScoutMenu.app");
  if (!existsSync(helperPath)) {
    throw new ScoutCliError("mounted app is missing ScoutMenu.app");
  }
  const helperInfoPlist = join(helperPath, "Contents", "Info.plist");
  if (plistValue(helperInfoPlist, "CFBundleIdentifier") !== HELPER_BUNDLE_ID) {
    throw new ScoutCliError(`mounted helper bundle identifier is not ${HELPER_BUNDLE_ID}`);
  }
  if (plistValue(helperInfoPlist, "CFBundleShortVersionString") !== expectedVersion) {
    throw new ScoutCliError(`mounted helper version is not ${expectedVersion}`);
  }
  if (plistValue(helperInfoPlist, "LSMinimumSystemVersion") !== MINIMUM_MACOS_VERSION) {
    throw new ScoutCliError(`mounted helper does not require macOS ${MINIMUM_MACOS_VERSION}`);
  }
  verifyDeveloperIdSignature(helperPath, "ScoutMenu.app");
  commandOutput("xcrun", ["stapler", "validate", appPath], "app notarization ticket");
  commandOutput("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath], "app Gatekeeper assessment");
}

function mountDmg(dmgPath: string): string {
  const result = spawnSync(
    "hdiutil",
    ["attach", dmgPath, "-readonly", "-nobrowse", "-noautoopen", "-plist"],
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

function copyAppFromMount(mountPoint: string, expectedVersion: string): void {
  const source = join(mountPoint, APP_NAME);
  if (!existsSync(source)) {
    throw new ScoutCliError(`no ${APP_NAME} found in the mounted DMG at ${mountPoint}`);
  }
  verifyAppBundle(source, expectedVersion);

  const stagingPath = `/Applications/.OpenScout.scout-install-${process.pid}.app`;
  const backupPath = `/Applications/.OpenScout.scout-backup-${process.pid}.app`;
  const hadExistingApp = existsSync(APP_PATH);
  spawnSync("rm", ["-rf", stagingPath, backupPath], { encoding: "utf8" });

  const copied = spawnSync("ditto", [source, stagingPath], { encoding: "utf8" });
  if ((copied.status ?? 1) !== 0) {
    throw new ScoutCliError(
      `could not stage ${APP_PATH}: ${copied.stderr.trim() || "permission denied?"}. Try: sudo scout install`,
    );
  }
  verifyAppBundle(stagingPath, expectedVersion);

  let backupCreated = false;
  try {
    if (hadExistingApp) {
      const movedOld = spawnSync("mv", [APP_PATH, backupPath], { encoding: "utf8" });
      if ((movedOld.status ?? 1) !== 0) {
        throw new ScoutCliError(
          `could not preserve the existing ${APP_PATH}: ${movedOld.stderr.trim() || "permission denied?"}. Try: sudo scout install`,
        );
      }
      backupCreated = true;
    }

    const installed = spawnSync("mv", [stagingPath, APP_PATH], { encoding: "utf8" });
    if ((installed.status ?? 1) !== 0) {
      if (backupCreated) spawnSync("mv", [backupPath, APP_PATH], { encoding: "utf8" });
      throw new ScoutCliError(`could not install ${APP_PATH}; the previous app was preserved`);
    }
    verifyAppBundle(APP_PATH, expectedVersion);
    if (backupCreated) spawnSync("rm", ["-rf", backupPath], { encoding: "utf8" });
  } catch (error) {
    spawnSync("rm", ["-rf", stagingPath], { encoding: "utf8" });
    if (backupCreated && existsSync(backupPath)) {
      if (existsSync(APP_PATH)) spawnSync("rm", ["-rf", APP_PATH], { encoding: "utf8" });
      spawnSync("mv", [backupPath, APP_PATH], { encoding: "utf8" });
    } else if (!hadExistingApp && existsSync(APP_PATH)) {
      spawnSync("rm", ["-rf", APP_PATH], { encoding: "utf8" });
    }
    throw error;
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
  const target = appVersionFromReleaseTag(release.tag_name);

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
  if (process.arch !== "arm64") {
    throw new ScoutCliError("Scout for macOS currently requires Apple silicon (arm64).");
  }
  const macosVersion = commandOutput("sw_vers", ["-productVersion"], "macOS version").trim();
  const macosMajor = Number.parseInt(macosVersion.split(".")[0] ?? "", 10);
  if (!Number.isInteger(macosMajor) || macosMajor < MINIMUM_MACOS_MAJOR) {
    throw new ScoutCliError(`Scout requires macOS ${MINIMUM_MACOS_MAJOR} or later (found ${macosVersion}).`);
  }

  const options = parseInstallArgs(args);

  if (options.check) {
    await runCheck(context, options);
    return;
  }

  const installedBefore = getInstalledVersion();
  context.stderr(options.version ? `Fetching release ${options.version}…` : "Fetching the latest OpenScout release…");
  const release = await fetchRelease(options.version);
  const target = appVersionFromReleaseTag(release.tag_name);

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
    verifyDmg(dmgPath);
    context.stderr(`Installing OpenScout ${target} to ${APP_PATH}…`);
    mountPoint = mountDmg(dmgPath);
    copyAppFromMount(mountPoint, target);
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
