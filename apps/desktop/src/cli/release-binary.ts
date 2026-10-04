import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ScoutCliError } from "./errors.ts";

/**
 * Prebuilt native binaries that ride on the public `oscout/scout` GitHub
 * release for each version, fetched on first use instead of shipped in the npm
 * tarball (and never by an install script).
 *
 * Each release carries, per tool:
 *   <name>-<version>-<target>.tar.gz   one archive per platform, holding <name>
 *   <name>-<version>-sha256sums.txt    `<sha256>  <archive>` per line
 *
 * The CLI only ever asks for the build that matches its own version.
 */

export const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/oscout/scout/releases/download";

export type ReleaseTarget = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export const RELEASE_TARGETS: readonly ReleaseTarget[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

export type ReleaseFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ReleaseBinaryOptions = {
  /** Binary and asset prefix, e.g. `scout-tui`. */
  name: string;
  version: string;
  /** Root of the version-keyed cache: `<root>/<version>/<name>`. */
  cacheRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: ReleaseFetch;
  /** One short progress line; the caller decides where it goes. */
  log?: (line: string) => void;
  attempts?: number;
  totalTimeoutMs?: number;
  stallTimeoutMs?: number;
  retryDelayMs?: number;
};

export type InstalledReleaseBinary = {
  name: string;
  version: string;
  target: ReleaseTarget;
  path: string;
  sha256: string;
  url: string;
  installedAt: string;
};

const RECEIPT_FILE = "receipt.json";

export function releaseTargetFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ReleaseTarget | null {
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `darwin-${cpu}`;
  if (platform === "linux") return `linux-${cpu}`;
  return null;
}

export function releaseArchiveName(name: string, version: string, target: ReleaseTarget): string {
  return `${name}-${version}-${target}.tar.gz`;
}

export function releaseManifestName(name: string, version: string): string {
  return `${name}-${version}-sha256sums.txt`;
}

export function releaseBaseUrl(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.OPENSCOUT_RELEASE_BASE_URL?.trim() || RELEASE_DOWNLOAD_BASE_URL).replace(/\/+$/, "");
  return `${base}/v${version}`;
}

/** Parses `sha256sum` output: `<hex>  <file>` (or `<hex> *<file>`) per line. */
export function parseSha256Manifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (match) entries.set(match[2]!, match[1]!.toLowerCase());
  }
  return entries;
}

export function unsupportedPlatformMessage(name: string, platform: string, arch: string): string {
  return [
    `${name} has no prebuilt binary for ${platform}-${arch} (prebuilt: ${RELEASE_TARGETS.join(", ")}).`,
    `Build it from source (cargo install --git https://github.com/oscout/scout ${name}) and point SCOUT_TUI_BIN at it.`,
  ].join("\n");
}

function versionDirectory(options: Pick<ReleaseBinaryOptions, "cacheRoot" | "version">): string {
  return join(options.cacheRoot, options.version);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The cached binary for exactly this version, if a finished install left one. */
export function findCachedReleaseBinary(options: Pick<ReleaseBinaryOptions, "name" | "cacheRoot" | "version">): InstalledReleaseBinary | null {
  const directory = versionDirectory(options);
  const path = join(directory, options.name);
  // The receipt is written last, so a binary without one is a torn install.
  const receiptPath = join(directory, RECEIPT_FILE);
  if (!existsSync(receiptPath) || !isExecutable(path)) return null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as InstalledReleaseBinary;
    return { ...receipt, path };
  } catch {
    return null;
  }
}

export function listCachedReleaseVersions(cacheRoot: string): string[] {
  if (!existsSync(cacheRoot)) return [];
  return readdirSync(cacheRoot).filter((entry) => !entry.startsWith(".")).sort();
}

export function removeCachedReleaseBinaries(cacheRoot: string): boolean {
  const existed = listCachedReleaseVersions(cacheRoot).length > 0;
  rmSync(cacheRoot, { recursive: true, force: true });
  return existed;
}

class PermanentDownloadError extends ScoutCliError {}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET a URL into memory. Aborts when the whole request outlives `totalMs`, or
 * when no bytes arrive for `stallMs` (headers included). 404 is permanent;
 * other failures are retryable.
 */
async function fetchBytes(
  url: string,
  fetchImpl: ReleaseFetch,
  timing: { totalMs: number; stallMs: number },
  onStart?: (size: number | null) => void,
): Promise<Buffer> {
  const controller = new AbortController();
  let reason = "";
  let rejectAborted: (error: Error) => void = () => {};
  // Raced against every await, so a fetch or body that ignores the signal still unblocks.
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  aborted.catch(() => {});
  const abort = (why: string) => {
    reason = why;
    controller.abort();
    rejectAborted(new ScoutCliError(why));
  };
  const total = setTimeout(() => abort(`timed out after ${Math.round(timing.totalMs / 1000)}s`), timing.totalMs);
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => abort(`stalled: no data for ${Math.round(timing.stallMs / 1000)}s`), timing.stallMs);
  };
  try {
    armStall();
    let response: Response;
    try {
      response = await Promise.race([fetchImpl(url, { signal: controller.signal, redirect: "follow" }), aborted]);
    } catch (error) {
      throw new ScoutCliError(reason || (error instanceof Error ? error.message : String(error)));
    }
    if (response.status === 404) throw new PermanentDownloadError(`not found (404): ${url}`);
    if (!response.ok) throw new ScoutCliError(`HTTP ${response.status} from ${url}`);
    if (!response.body) throw new ScoutCliError(`empty response from ${url}`);
    const length = Number(response.headers.get("content-length"));
    onStart?.(Number.isFinite(length) && length > 0 ? length : null);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    armStall();
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        if (value) chunks.push(value);
        armStall();
      }
    } catch (error) {
      reader.cancel().catch(() => {});
      throw new ScoutCliError(reason || (error instanceof Error ? error.message : String(error)));
    }
    if (reason) throw new ScoutCliError(reason);
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(total);
    if (stall) clearTimeout(stall);
  }
}

async function withRetries<T>(attempts: number, delayMs: number, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (error instanceof PermanentDownloadError || attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Download, verify and cache the binary for this platform and version. The
 * archive's sha256 must match the release manifest or nothing is installed.
 * Older cached versions are removed once the new one is in place.
 */
export async function installReleaseBinary(options: ReleaseBinaryOptions): Promise<InstalledReleaseBinary> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = releaseTargetFor(platform, arch);
  if (!target) throw new ScoutCliError(unsupportedPlatformMessage(options.name, platform, arch));

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const timing = {
    totalMs: options.totalTimeoutMs ?? 3 * 60_000,
    stallMs: options.stallTimeoutMs ?? 20_000,
  };
  const base = releaseBaseUrl(options.version, env);
  const archive = releaseArchiveName(options.name, options.version, target);
  const manifestUrl = `${base}/${releaseManifestName(options.name, options.version)}`;
  const archiveUrl = `${base}/${archive}`;
  const notPublished = `${options.name} ${options.version} isn't published for ${target} yet (${base}). Try again after the release finishes, or set SCOUT_TUI_BIN.`;

  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

  let manifest: Map<string, string>;
  try {
    const bytes = await withRetries(attempts, retryDelayMs, () => fetchBytes(manifestUrl, fetchImpl, { totalMs: 30_000, stallMs: timing.stallMs }));
    manifest = parseSha256Manifest(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof PermanentDownloadError) throw new ScoutCliError(notPublished);
    throw new ScoutCliError(`Couldn't download the ${options.name} checksums: ${describe(error)}`);
  }
  const expected = manifest.get(archive);
  if (!expected) throw new ScoutCliError(notPublished);

  let announced = false;
  let bytes: Buffer;
  try {
    bytes = await withRetries(attempts, retryDelayMs, () => fetchBytes(archiveUrl, fetchImpl, timing, (size) => {
      if (announced) return;
      announced = true;
      options.log?.(`Downloading ${options.name} ${options.version} for ${target}${size ? ` (${formatMegabytes(size)})` : ""}…`);
    }));
  } catch (error) {
    if (error instanceof PermanentDownloadError) throw new ScoutCliError(notPublished);
    throw new ScoutCliError(`Couldn't download ${options.name}: ${describe(error)}`);
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new ScoutCliError(`${options.name} checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…); not installing or running it.`);
  }

  mkdirSync(options.cacheRoot, { recursive: true });
  const work = join(options.cacheRoot, `.install-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const finalDirectory = versionDirectory(options);
  try {
    const archivePath = join(work, archive);
    writeFileSync(archivePath, bytes);
    const unpacked = join(work, options.version);
    mkdirSync(unpacked, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", archivePath, "-C", unpacked], { encoding: "utf8" });
    if (tar.status !== 0) {
      throw new ScoutCliError(`Couldn't unpack ${archive}: ${(tar.stderr || tar.error?.message || "tar failed").trim()}`);
    }
    const binary = join(unpacked, options.name);
    if (!existsSync(binary)) throw new ScoutCliError(`${archive} doesn't contain ${options.name}; not installing it.`);
    chmodSync(binary, 0o755);
    const receipt: InstalledReleaseBinary = {
      name: options.name,
      version: options.version,
      target,
      path: join(finalDirectory, options.name),
      sha256: actual,
      url: archiveUrl,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(join(unpacked, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);

    rmSync(finalDirectory, { recursive: true, force: true });
    renameSync(unpacked, finalDirectory);

    // Only this CLI's version is ever launched; older copies are dead weight.
    for (const entry of readdirSync(options.cacheRoot)) {
      if (entry !== options.version && !entry.startsWith(".")) {
        rmSync(join(options.cacheRoot, entry), { recursive: true, force: true });
      }
    }
    return receipt;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
