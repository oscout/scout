import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  mkdtempSync as fsMkdtempSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export const OPENSCOUT_RELEASE_OWNER = "oscout";
export const OPENSCOUT_RELEASE_REPOSITORY = "scout";
export const OPENSCOUT_APP_NAME = "OpenScout.app";
/** Verified OpenScout product bundle id. Not user-configurable. */
export const OPENSCOUT_APP_BUNDLE_ID = "app.openscout.scout";
/** Verified Developer ID TeamIdentifier. Not user-configurable. */
export const OPENSCOUT_SIGNING_TEAM_ID = "2U83JFPW66";
export const DEFAULT_OPENSCOUT_APP_PATH = `/Applications/${OPENSCOUT_APP_NAME}`;
const GITHUB_ASSET_DIGEST_ALGORITHM = "sha256";
const GITHUB_ASSET_DIGEST_HEX_LENGTH = 64;
const LATEST_DMG_ALIAS = "OpenScout.dmg";

const USER_AGENT = "scout-cli";
const BACKUP_SUFFIX = ".openscout-previous";
const INSTALL_LOCK_SUFFIX = ".openscout-install.lock";
const SHLOCK_PATH = "/usr/bin/shlock";
const STOP_POLL_ATTEMPTS = 50;
const STOP_POLL_MS = 100;
const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export type ScoutInstallOptions = {
  check: boolean;
  force: boolean;
  version: string | null;
  restart: boolean;
};

export type GithubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
};

export type GithubRelease = {
  tag_name: string;
  name: string;
  assets: GithubReleaseAsset[];
};

export type GithubAssetDigest = {
  algorithm: string;
  hex: string;
};

export type ScoutInstallStatus =
  | "installed"
  | "updated"
  | "up-to-date"
  | "not-installed"
  | "repair-needed"
  | "update-available";

export type ScoutInstallResult = {
  action: "install" | "check";
  status: ScoutInstallStatus;
  installed: string | null;
  target: string | null;
  bundlePath: string;
  message: string;
};

export type ScoutInstallCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type ScoutInstallCommandRunner = (
  command: string,
  args: readonly string[],
) => ScoutInstallCommandResult;

export type ScoutInstallFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type ScoutInstallDependencies = {
  platform?: NodeJS.Platform;
  fetch?: ScoutInstallFetcher;
  run?: ScoutInstallCommandRunner;
  existsSync?: (path: string) => boolean;
  mkdirSync?: (path: string, options?: { recursive?: boolean }) => void;
  mkdtempSync?: (prefix: string) => string;
  writeFileSync?: (path: string, data: Uint8Array) => void;
  rmSync?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  renameSync?: (from: string, to: string) => void;
  tmpdir?: () => string;
  sleep?: (ms: number) => void;
  appPath?: string;
};

type ResolvedInstallDependencies = {
  platform: NodeJS.Platform;
  fetch: ScoutInstallFetcher;
  run: ScoutInstallCommandRunner;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  mkdtempSync: (prefix: string) => string;
  writeFileSync: (path: string, data: Uint8Array) => void;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  renameSync: (from: string, to: string) => void;
  tmpdir: () => string;
  sleep: (ms: number) => void;
  appPath: string;
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
    "  verifies the published byte size and sha256 digest when GitHub provides one,",
    "  then codesign and Gatekeeper-assess the DMG before mounting. OpenScout.app",
    "  must match the pinned bundle id and Team ID, pass codesign --deep --strict,",
    "  and pass Gatekeeper execute after staging. A running copy of the installed",
    "  app is stopped first; replacement is staged and rolled back on failure.",
    "  Quarantine attributes are not cleared.",
    "",
    "  The app uses the local scout CLI for the bundled runtime. Install the CLI",
    "  with `bun add -g @openscout/scout`.",
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
      const value = arg.slice("--version=".length);
      if (!value) {
        throw new ScoutCliError("--version requires a release tag (e.g. --version v0.2.70)");
      }
      options.version = value;
      continue;
    }
    if (arg.startsWith("--tag=")) {
      const value = arg.slice("--tag=".length);
      if (!value) {
        throw new ScoutCliError("--tag requires a release tag (e.g. --tag v0.2.70)");
      }
      options.version = value;
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

function normalizeReleaseVersion(tag: string): string {
  const version = stripLeadingV(tag);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new ScoutCliError(`unsupported OpenScout release tag: ${tag}`);
  }
  return version;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "unknown size";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function combinedOutput(result: ScoutInstallCommandResult): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function permissionDeniedMessage(destination: string, detail?: string): string {
  const suffix = detail?.trim() ? `: ${detail.trim()}` : ".";
  return `could not replace ${destination} (permission denied)${suffix} Grant write access to the destination and retry.`;
}

function isPermissionError(error: unknown, result?: ScoutInstallCommandResult): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return true;
  const output = `${error instanceof Error ? error.message : ""} ${result?.stderr ?? ""} ${result?.stdout ?? ""}`.toLowerCase();
  return output.includes("permission denied") || output.includes("operation not permitted");
}

function defaultRun(command: string, args: readonly string[]): ScoutInstallCommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function defaultSleep(ms: number): void {
  Bun.sleepSync(ms);
}

function resolveInstallDependencies(
  dependencies: ScoutInstallDependencies = {},
): ResolvedInstallDependencies {
  return {
    platform: dependencies.platform ?? process.platform,
    fetch: dependencies.fetch ?? fetch,
    run: dependencies.run ?? defaultRun,
    existsSync: dependencies.existsSync ?? fsExistsSync,
    mkdirSync: dependencies.mkdirSync ?? ((path, options) => {
      fsMkdirSync(path, options);
    }),
    mkdtempSync: dependencies.mkdtempSync ?? fsMkdtempSync,
    writeFileSync: dependencies.writeFileSync ?? ((path, data) => {
      fsWriteFileSync(path, data);
    }),
    rmSync: dependencies.rmSync ?? fsRmSync,
    renameSync: dependencies.renameSync ?? fsRenameSync,
    tmpdir: dependencies.tmpdir ?? osTmpdir,
    sleep: dependencies.sleep ?? defaultSleep,
    appPath: dependencies.appPath ?? DEFAULT_OPENSCOUT_APP_PATH,
  };
}

function requireSuccess(
  result: ScoutInstallCommandResult,
  message: string,
): ScoutInstallCommandResult {
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new ScoutCliError(`${message}: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new ScoutCliError(
      `${message}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`}`,
    );
  }
  return result;
}

export function parseGithubAssetDigest(digest: string): GithubAssetDigest {
  const trimmed = digest.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0) {
    throw new ScoutCliError(`unsupported GitHub asset digest: ${digest}`);
  }
  // GitHub release assets publish `digest` as `sha256:<hex>` plus `size`.
  const algorithm = trimmed.slice(0, separator).trim().toLowerCase();
  const hex = trimmed.slice(separator + 1).trim().toLowerCase();
  if (
    algorithm !== GITHUB_ASSET_DIGEST_ALGORITHM
    || !/^[0-9a-f]+$/.test(hex)
    || hex.length !== GITHUB_ASSET_DIGEST_HEX_LENGTH
  ) {
    throw new ScoutCliError(`unsupported GitHub asset digest: ${digest}`);
  }
  return { algorithm, hex };
}

export function verifyDownloadedAsset(
  buffer: Uint8Array,
  asset: Pick<GithubReleaseAsset, "name" | "size" | "digest">,
): void {
  if (typeof asset.size !== "number" || !Number.isFinite(asset.size) || asset.size < 0) {
    throw new ScoutCliError(`release asset ${asset.name} is missing an exact byte size`);
  }
  if (buffer.byteLength !== asset.size) {
    throw new ScoutCliError(
      `download size mismatch for ${asset.name}: expected ${asset.size} bytes, got ${buffer.byteLength}`,
    );
  }
  if (buffer.byteLength === 0) {
    throw new ScoutCliError("download failed: empty response body");
  }

  const digest = asset.digest?.trim();
  if (!digest) return;

  const parsed = parseGithubAssetDigest(digest);
  let actual: string;
  try {
    actual = createHash(parsed.algorithm).update(buffer).digest("hex");
  } catch {
    throw new ScoutCliError(`unsupported GitHub asset digest algorithm: ${parsed.algorithm}`);
  }
  if (actual !== parsed.hex) {
    throw new ScoutCliError(
      `download digest mismatch for ${asset.name}: expected ${digest}, got ${parsed.algorithm}:${actual}`,
    );
  }
}

/**
 * Pick the product DMG. Only the exact versioned name derived from
 * `release.tag_name` (OpenScout-<version>.dmg) or the exact OpenScout.dmg
 * latest alias are accepted.
 */
export function findAppDmgAsset(release: GithubRelease): GithubReleaseAsset {
  const assets = release.assets ?? [];
  const versionedName = `OpenScout-${normalizeReleaseVersion(release.tag_name)}.dmg`;
  const versioned = assets.find((asset) => asset.name === versionedName);
  if (versioned) return versioned;

  const latestAlias = assets.find((asset) => asset.name === LATEST_DMG_ALIAS);
  if (latestAlias) return latestAlias;

  throw new ScoutCliError(
    `no OpenScout.app DMG found in release ${release.tag_name}. Assets: ${
      assets.map((asset) => asset.name).join(", ") || "(none)"
    }`,
  );
}

function infoPlistPath(appPath: string): string {
  return join(appPath, "Contents", "Info.plist");
}

function readPlistString(
  deps: ResolvedInstallDependencies,
  plistPath: string,
  key: string,
): string | null {
  if (!deps.existsSync(plistPath)) return null;
  const result = deps.run("plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
  if ((result.status ?? 1) !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function getInstalledVersion(deps: ResolvedInstallDependencies): string | null {
  return readPlistString(deps, infoPlistPath(deps.appPath), "CFBundleShortVersionString");
}

async function fetchRelease(
  version: string | null,
  deps: ResolvedInstallDependencies,
): Promise<GithubRelease> {
  const base = `https://api.github.com/repos/${OPENSCOUT_RELEASE_OWNER}/${OPENSCOUT_RELEASE_REPOSITORY}/releases`;
  const apiUrl = version ? `${base}/tags/${encodeURIComponent(version)}` : `${base}/latest`;

  try {
    const response = await deps.fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
    });
    if (response.ok) {
      return (await response.json()) as GithubRelease;
    }
  } catch {
    // Fall through to the gh CLI fallback.
  }

  const apiPath = version
    ? `repos/${OPENSCOUT_RELEASE_OWNER}/${OPENSCOUT_RELEASE_REPOSITORY}/releases/tags/${version}`
    : `repos/${OPENSCOUT_RELEASE_OWNER}/${OPENSCOUT_RELEASE_REPOSITORY}/releases/latest`;
  const gh = deps.run("gh", ["api", apiPath]);
  if ((gh.status ?? 1) === 0 && gh.stdout.trim()) {
    return JSON.parse(gh.stdout) as GithubRelease;
  }

  throw new ScoutCliError(
    version
      ? `release "${version}" not found on GitHub (${OPENSCOUT_RELEASE_OWNER}/${OPENSCOUT_RELEASE_REPOSITORY})`
      : `could not fetch the latest OpenScout release from GitHub (${OPENSCOUT_RELEASE_OWNER}/${OPENSCOUT_RELEASE_REPOSITORY})`,
  );
}

async function downloadDmg(
  asset: GithubReleaseAsset,
  destination: string,
  context: ScoutCommandContext,
  deps: ResolvedInstallDependencies,
): Promise<void> {
  context.stderr(`Downloading ${asset.name} (${formatBytes(asset.size)})…`);
  const response = await deps.fetch(asset.browser_download_url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new ScoutCliError(`download failed: HTTP ${response.status} for ${asset.browser_download_url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  verifyDownloadedAsset(buffer, asset);
  deps.writeFileSync(destination, buffer);
}

function mountDmg(dmgPath: string, mountPoint: string, deps: ResolvedInstallDependencies): void {
  deps.mkdirSync(mountPoint, { recursive: true });
  // Do not pass -noverify: hdiutil must checksum the disk image before attach.
  const result = deps.run("hdiutil", [
    "attach",
    dmgPath,
    "-mountpoint",
    mountPoint,
    "-nobrowse",
    "-readonly",
    "-noautoopen",
  ]);
  if ((result.status ?? 1) !== 0) {
    throw new ScoutCliError(
      `could not mount ${dmgPath}: ${result.stderr.trim() || result.stdout.trim() || "hdiutil attach failed"}`,
    );
  }
}

function unmountDmg(mountPoint: string, deps: ResolvedInstallDependencies): void {
  const detached = deps.run("hdiutil", ["detach", mountPoint, "-quiet"]);
  if ((detached.status ?? 1) === 0) return;
  deps.run("hdiutil", ["detach", mountPoint, "-force", "-quiet"]);
}

function requireMountedOpenScoutApp(mountPoint: string, deps: ResolvedInstallDependencies): string {
  const source = join(mountPoint, OPENSCOUT_APP_NAME);
  if (!deps.existsSync(source) || !deps.existsSync(infoPlistPath(source))) {
    throw new ScoutCliError(`no ${OPENSCOUT_APP_NAME} found in the mounted DMG at ${mountPoint}`);
  }
  return source;
}

function codesignField(output: string, key: string): string | null {
  const match = output.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

export function verifyDownloadedDmg(
  dmgPath: string,
  deps: ScoutInstallDependencies = {},
): void {
  const resolved = resolveInstallDependencies(deps);
  requireSuccess(
    resolved.run("codesign", ["--verify", "--strict", dmgPath]),
    `codesign --verify --strict failed for ${dmgPath}`,
  );
  requireSuccess(
    resolved.run("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "-vv",
      dmgPath,
    ]),
    `Gatekeeper rejected ${dmgPath}`,
  );
}

export function verifyStagedOpenScoutApp(
  bundlePath: string,
  deps: ScoutInstallDependencies = {},
  expectedVersion?: string,
): string {
  const resolved = resolveInstallDependencies(deps);
  if (!resolved.existsSync(infoPlistPath(bundlePath))) {
    throw new ScoutCliError(`${bundlePath} is missing Contents/Info.plist`);
  }

  const bundleId = readPlistString(resolved, infoPlistPath(bundlePath), "CFBundleIdentifier");
  if (bundleId !== OPENSCOUT_APP_BUNDLE_ID) {
    throw new ScoutCliError(
      `${OPENSCOUT_APP_NAME} bundle id is ${bundleId ?? "(missing)"}; expected ${OPENSCOUT_APP_BUNDLE_ID}`,
    );
  }

  const version = readPlistString(resolved, infoPlistPath(bundlePath), "CFBundleShortVersionString");
  if (!version) {
    throw new ScoutCliError(`${OPENSCOUT_APP_NAME} is missing CFBundleShortVersionString`);
  }
  if (expectedVersion && version !== expectedVersion) {
    throw new ScoutCliError(
      `${OPENSCOUT_APP_NAME} version is ${version}; expected release ${expectedVersion}`,
    );
  }

  requireSuccess(
    resolved.run("codesign", ["--verify", "--deep", "--strict", bundlePath]),
    `codesign --verify --deep --strict failed for ${bundlePath}`,
  );

  const details = requireSuccess(
    resolved.run("codesign", ["-dvv", bundlePath]),
    `could not read codesign details for ${bundlePath}`,
  );
  const detailsOutput = combinedOutput(details);

  const identifier = codesignField(detailsOutput, "Identifier");
  if (identifier !== OPENSCOUT_APP_BUNDLE_ID) {
    throw new ScoutCliError(
      `${OPENSCOUT_APP_NAME} signature identifier is ${identifier ?? "(missing)"}; expected ${OPENSCOUT_APP_BUNDLE_ID}`,
    );
  }

  const teamId = codesignField(detailsOutput, "TeamIdentifier");
  if (teamId !== OPENSCOUT_SIGNING_TEAM_ID) {
    throw new ScoutCliError(
      `${OPENSCOUT_APP_NAME} signing Team ID is ${teamId ?? "(missing)"}; expected ${OPENSCOUT_SIGNING_TEAM_ID}`,
    );
  }

  if (!/^Authority=Developer ID Application:/m.test(detailsOutput)) {
    throw new ScoutCliError(`${OPENSCOUT_APP_NAME} is not signed with Developer ID Application`);
  }

  requireSuccess(
    resolved.run("spctl", ["--assess", "--type", "execute", "-vv", bundlePath]),
    `Gatekeeper rejected ${bundlePath}`,
  );

  return version;
}

function copyApp(source: string, destination: string, deps: ResolvedInstallDependencies): void {
  const copied = deps.run("ditto", [source, destination]);
  if ((copied.status ?? 1) !== 0) {
    if (isPermissionError(copied.error, copied)) {
      throw new ScoutCliError(permissionDeniedMessage(destination, copied.stderr));
    }
    throw new ScoutCliError(
      `could not copy the app to ${destination}: ${copied.stderr.trim() || copied.stdout.trim() || "ditto failed"}`,
    );
  }
}

function moveReplacing(
  source: string,
  destination: string,
  deps: ResolvedInstallDependencies,
): void {
  try {
    deps.renameSync(source, destination);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EXDEV") {
      if (isPermissionError(error)) {
        throw new ScoutCliError(permissionDeniedMessage(destination));
      }
      throw new ScoutCliError(
        `could not move ${source} to ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  copyApp(source, destination, deps);
  deps.rmSync(source, { recursive: true, force: true });
}

function backupPathFor(appPath: string): string {
  return `${appPath}${BACKUP_SUFFIX}`;
}

function installLockPathFor(appPath: string): string {
  return `${appPath}${INSTALL_LOCK_SUFFIX}`;
}

function acquireInstallLock(deps: ResolvedInstallDependencies): () => void {
  const lockPath = installLockPathFor(deps.appPath);
  // macOS shlock uses an atomic link, validates the recorded PID with kill(0),
  // and replaces a stale owner before returning success.
  const result = deps.run(SHLOCK_PATH, ["-f", lockPath, "-p", String(process.pid)]);
  if ((result.status ?? 1) !== 0) {
    if (isPermissionError(result.error, result)) {
      throw new ScoutCliError(permissionDeniedMessage(lockPath, result.stderr));
    }
    throw new ScoutCliError(
      `another scout install is already updating ${deps.appPath}. `
      + `If no installer is running, remove the stale lock at ${lockPath} and retry.`,
    );
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    deps.rmSync(lockPath, { force: true });
  };
}

function recoverIncompleteInstall(deps: ResolvedInstallDependencies): void {
  const backupPath = backupPathFor(deps.appPath);
  const destExists = deps.existsSync(deps.appPath);
  const backupExists = deps.existsSync(backupPath);
  if (!destExists && backupExists) {
    verifyStagedOpenScoutApp(backupPath, deps);
    deps.renameSync(backupPath, deps.appPath);
    return;
  }
  if (destExists && backupExists) {
    let destinationError: unknown = null;
    try {
      verifyStagedOpenScoutApp(deps.appPath, deps);
    } catch (error) {
      destinationError = error;
    }
    if (!destinationError) {
      // The replacement committed before the previous process exited. Keep the
      // verified destination and finish the post-commit cleanup. This cleanup
      // is not a rollback boundary.
      deps.rmSync(backupPath, { recursive: true, force: true });
      return;
    }
    try {
      verifyStagedOpenScoutApp(backupPath, deps);
    } catch (backupError) {
      throw new ScoutCliError(
        `incomplete prior install found, but neither ${deps.appPath} nor ${backupPath} passed verification: `
        + `${destinationError instanceof Error ? destinationError.message : String(destinationError)}; `
        + `${backupError instanceof Error ? backupError.message : String(backupError)}`,
      );
    }
    deps.rmSync(deps.appPath, { recursive: true, force: true });
    deps.renameSync(backupPath, deps.appPath);
  }
}

function replaceAppTransactionally(
  stagedPath: string,
  deps: ResolvedInstallDependencies,
  expectedVersion: string,
): string {
  const backupPath = backupPathFor(deps.appPath);
  const hadPriorApp = deps.existsSync(deps.appPath);
  let backedUp = false;
  let installedVersion = "";

  try {
    if (hadPriorApp) {
      try {
        deps.renameSync(deps.appPath, backupPath);
      } catch (error) {
        if (isPermissionError(error)) {
          throw new ScoutCliError(permissionDeniedMessage(deps.appPath));
        }
        throw new ScoutCliError(
          `could not move the installed app aside: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      backedUp = true;
    }

    moveReplacing(stagedPath, deps.appPath, deps);
    installedVersion = verifyStagedOpenScoutApp(deps.appPath, deps, expectedVersion);
  } catch (error) {
    if (backedUp) {
      if (deps.existsSync(deps.appPath)) {
        deps.rmSync(deps.appPath, { recursive: true, force: true });
      }
      if (deps.existsSync(backupPath)) {
        try {
          deps.renameSync(backupPath, deps.appPath);
        } catch {
          throw new ScoutCliError(
            `install failed and rollback failed. The previous app is at ${backupPath}. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } else if (!hadPriorApp && deps.existsSync(deps.appPath)) {
      deps.rmSync(deps.appPath, { recursive: true, force: true });
    }
    throw error;
  }

  // Verification commits the transaction. Backup cleanup is deliberately
  // outside the rollback region: a cleanup error must never delete a verified
  // new app or try to restore a partially removed backup.
  if (backedUp && deps.existsSync(backupPath)) {
    deps.rmSync(backupPath, { recursive: true, force: true });
  }
  if (!installedVersion) {
    throw new ScoutCliError(`installed ${OPENSCOUT_APP_NAME} has no verified version`);
  }
  return installedVersion;
}

function executableIsInsideApp(executable: string, appPath: string): boolean {
  const normalizedApp = appPath.endsWith("/") ? appPath.slice(0, -1) : appPath;
  return executable === normalizedApp || executable.startsWith(`${normalizedApp}/`);
}

export function processIdsForInstalledApp(psOutput: string, appPath: string): number[] {
  const pids: number[] = [];
  for (const rawLine of psOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\S+)/);
    if (!match) continue;
    const pid = Number(match[1]);
    const executable = match[2];
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (executableIsInsideApp(executable, appPath)) pids.push(pid);
  }
  return pids;
}

function listInstalledAppPids(deps: ResolvedInstallDependencies): number[] {
  const result = deps.run("ps", ["-axo", "pid=,args="]);
  requireSuccess(result, "could not inspect running OpenScout processes");
  return processIdsForInstalledApp(result.stdout, deps.appPath);
}

function isAppRunning(deps: ResolvedInstallDependencies): boolean {
  return listInstalledAppPids(deps).length > 0;
}

function waitUntilStopped(deps: ResolvedInstallDependencies, attempts: number): boolean {
  for (let index = 0; index < attempts; index += 1) {
    if (!isAppRunning(deps)) return true;
    if (index + 1 < attempts) deps.sleep(STOP_POLL_MS);
  }
  return !isAppRunning(deps);
}

function stopRunningApp(deps: ResolvedInstallDependencies): boolean {
  const initialPids = listInstalledAppPids(deps);
  if (initialPids.length === 0) return false;

  for (const pid of initialPids) {
    deps.run("kill", [String(pid)]);
  }
  if (waitUntilStopped(deps, STOP_POLL_ATTEMPTS)) return true;

  for (const pid of listInstalledAppPids(deps)) {
    deps.run("kill", ["-9", String(pid)]);
  }
  if (waitUntilStopped(deps, STOP_POLL_ATTEMPTS)) return true;

  throw new ScoutCliError("could not stop OpenScout before replacing it");
}

function launchApp(deps: ResolvedInstallDependencies): void {
  requireSuccess(deps.run("open", [deps.appPath]), `could not relaunch ${deps.appPath}`);
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

async function runCheck(
  context: ScoutCommandContext,
  options: ScoutInstallOptions,
  deps: ResolvedInstallDependencies,
): Promise<void> {
  const release = await fetchRelease(options.version, deps);
  const target = normalizeReleaseVersion(release.tag_name);
  let installed = getInstalledVersion(deps);

  let status: ScoutInstallStatus;
  let message: string;
  if (!deps.existsSync(deps.appPath)) {
    if (deps.existsSync(backupPathFor(deps.appPath))) {
      status = "repair-needed";
      message = "An interrupted OpenScout install needs repair — run `scout install --force`.";
    } else {
      status = "not-installed";
      message = "OpenScout is not installed — run `scout install`.";
    }
  } else {
    try {
      installed = verifyStagedOpenScoutApp(deps.appPath, deps);
      if (installed === target) {
        status = "up-to-date";
        message = `OpenScout ${installed} is up to date.`;
      } else {
        status = "update-available";
        message = `Update available: ${installed} → ${target}. Run \`scout install\`.`;
      }
    } catch (error) {
      status = "repair-needed";
      message = `OpenScout needs repair (${error instanceof Error ? error.message : String(error)}). `
        + "Run `scout install --force`.";
    }
  }

  context.output.writeValue(
    { action: "check", status, installed, target, bundlePath: deps.appPath, message },
    renderInstallResult,
  );
}

export async function runInstallCommand(
  context: ScoutCommandContext,
  args: string[],
  dependencies: ScoutInstallDependencies = {},
): Promise<void> {
  if (HELP_FLAGS.has(args[0] ?? "")) {
    context.output.writeText(renderInstallCommandHelp());
    return;
  }

  const deps = resolveInstallDependencies(dependencies);
  if (deps.platform !== "darwin") {
    throw new ScoutCliError("scout install is only supported on macOS.");
  }

  const options = parseInstallArgs(args);
  if (options.version) normalizeReleaseVersion(options.version);

  if (options.check) {
    await runCheck(context, options, deps);
    return;
  }

  context.stderr(options.version ? `Fetching release ${options.version}…` : "Fetching the latest OpenScout release…");
  const release = await fetchRelease(options.version, deps);
  const target = normalizeReleaseVersion(release.tag_name);
  const releaseInstallLock = acquireInstallLock(deps);

  try {
    recoverIncompleteInstall(deps);
    const hadInstalledApp = deps.existsSync(deps.appPath);
    const installedBefore = getInstalledVersion(deps);
    let repairingInstalledApp = false;

    if (!options.force && installedBefore === target) {
      try {
        const verifiedVersion = verifyStagedOpenScoutApp(deps.appPath, deps, target);
        context.output.writeValue(
          {
            action: "install",
            status: "up-to-date",
            installed: verifiedVersion,
            target,
            bundlePath: deps.appPath,
            message: `OpenScout ${target} is already installed (use --force to reinstall).`,
          } satisfies ScoutInstallResult,
          renderInstallResult,
        );
        return;
      } catch (error) {
        repairingInstalledApp = true;
        context.stderr(
          `Installed OpenScout ${target} failed verification; repairing it: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const asset = findAppDmgAsset(release);
    const workDir = deps.mkdtempSync(join(deps.tmpdir(), "scout-install-"));
    const dmgPath = join(workDir, asset.name);
    const mountPoint = join(workDir, "mnt");
    const stagedPath = join(workDir, OPENSCOUT_APP_NAME);
    let mounted = false;
    let wasRunning = false;
    let installedAfter = "";

    try {
      await downloadDmg(asset, dmgPath, context, deps);
      context.stderr(`Installing OpenScout ${target} to ${deps.appPath}…`);
      verifyDownloadedDmg(dmgPath, deps);
      mountDmg(dmgPath, mountPoint, deps);
      mounted = true;
      const source = requireMountedOpenScoutApp(mountPoint, deps);
      copyApp(source, stagedPath, deps);
      verifyStagedOpenScoutApp(stagedPath, deps, target);
      wasRunning = stopRunningApp(deps);
      installedAfter = replaceAppTransactionally(stagedPath, deps, target);
    } finally {
      if (mounted) unmountDmg(mountPoint, deps);
      deps.rmSync(workDir, { recursive: true, force: true });
    }

    if (wasRunning && options.restart) {
      launchApp(deps);
    }

    const status: ScoutInstallStatus = hadInstalledApp ? "updated" : "installed";
    const relaunchNote = wasRunning
      ? options.restart
        ? " (relaunched)"
        : " (restart OpenScout to use the new version)"
      : "";
    let verb = "Installed";
    if (repairingInstalledApp || (hadInstalledApp && !installedBefore)) {
      verb = "Repaired";
    } else if (installedBefore) {
      verb = `Updated ${installedBefore} →`;
    }

    context.output.writeValue(
      {
        action: "install",
        status,
        installed: installedAfter,
        target,
        bundlePath: deps.appPath,
        message: `${verb} OpenScout ${installedAfter} → ${deps.appPath}${relaunchNote}`,
      } satisfies ScoutInstallResult,
      renderInstallResult,
    );
  } finally {
    releaseInstallLock();
  }
}
