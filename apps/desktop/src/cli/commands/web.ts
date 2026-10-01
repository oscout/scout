import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";
import {
  readWebFullClientProfile,
  resolveInstalledWebFullClient,
  webFullClientDirectory,
  webFullClientsDirectory,
} from "@openscout/runtime/web-full-client";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { SCOUT_APP_VERSION } from "../../shared/product.ts";
import { requestScoutWebControl } from "./server.ts";

export const SCOUT_DIST_DEFAULT_URL = "https://console.openscout.app";
const DIST_KEY_PREFIX = "osdist_";
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

type ScoutFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ScoutWebCommandDeps = {
  fetchImpl?: ScoutFetch;
  supportDirectory?: string;
  version?: string;
  readStdin?: () => Promise<string>;
  keyStores?: DistKeyStore[];
  promptKey?: () => Promise<string>;
  restartWeb?: () => Promise<string>;
};

export function renderWebCommandHelp(): string {
  return [
    "scout web — the full Scout web app",
    "",
    "The npm package serves the basic web app (Home, DMs, Tail). Accounts with",
    "access download the full app for this Scout version from console.openscout.app.",
    "",
    "Usage:",
    "  scout web login                 Paste a download key (asked for, not echoed)",
    "  scout web login --key <key|->   Pass the key directly, or - to read stdin",
    "  scout web install [--version <x.y.z>] [--no-restart]",
    "                                  Download, verify and install the full web app",
    "  scout web status                Show the key, the installed app, and what's served",
    "  scout web uninstall             Remove installed full web apps (back to basic)",
    "  scout web logout                Forget the saved download key",
    "",
    "Create a key at https://console.openscout.app/#downloads. SCOUT_DIST_KEY",
    "overrides the saved key (handy for VMs and CI). OPENSCOUT_DIST_URL points",
    "at another download host.",
  ].join("\n");
}

function distBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.OPENSCOUT_DIST_URL?.trim() || SCOUT_DIST_DEFAULT_URL).replace(/\/+$/, "");
}

function supportDirectoryOf(deps: ScoutWebCommandDeps): string {
  return deps.supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
}

export function distKeyPath(supportDirectory: string): string {
  return join(supportDirectory, "web", "dist-key");
}

/**
 * Where a saved download key lives. The OS credential store when there is one
 * (macOS Keychain, or the Secret Service via secret-tool on Linux desktops),
 * so the key is encrypted at rest; otherwise a 0600 file, which `scout web
 * status` reports as unencrypted. The key always reaches the store on stdin,
 * never in argv.
 */
export type DistKeyStore = {
  where: string;
  encrypted: boolean;
  read(): string | null;
  write(key: string): boolean;
  remove(): boolean;
};

type SpawnText = (command: string, args: string[], input?: string) => { status: number | null; stdout: string };

const spawnText: SpawnText = (command, args, input) => {
  const result = spawnSync(command, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
};

export const DIST_KEY_KEYCHAIN_SERVICE = "OPENSCOUT_DIST_KEY";
const SAFE_KEY = /^[A-Za-z0-9_]+$/;

export function keychainDistKeyStore(spawn: SpawnText = spawnText): DistKeyStore {
  return {
    where: `macOS Keychain (${DIST_KEY_KEYCHAIN_SERVICE})`,
    encrypted: true,
    read() {
      const result = spawn("security", ["find-generic-password", "-a", "openscout", "-s", DIST_KEY_KEYCHAIN_SERVICE, "-w"]);
      return result.status === 0 ? result.stdout.trim() || null : null;
    },
    write(key) {
      // `security -i` reads the command from stdin, so the key stays out of argv.
      if (!SAFE_KEY.test(key)) return false;
      const script = `add-generic-password -U -a openscout -s ${DIST_KEY_KEYCHAIN_SERVICE} -l "Scout download key" -w "${key}"\n`;
      return spawn("security", ["-i"], script).status === 0;
    },
    remove() {
      return spawn("security", ["delete-generic-password", "-a", "openscout", "-s", DIST_KEY_KEYCHAIN_SERVICE]).status === 0;
    },
  };
}

export function secretServiceDistKeyStore(spawn: SpawnText = spawnText): DistKeyStore {
  const attributes = ["service", "openscout-dist", "account", "default"];
  return {
    where: "Secret Service (secret-tool, service openscout-dist)",
    encrypted: true,
    read() {
      const result = spawn("secret-tool", ["lookup", ...attributes]);
      return result.status === 0 ? result.stdout.trim() || null : null;
    },
    write(key) {
      return spawn("secret-tool", ["store", "--label=Scout download key", ...attributes], key).status === 0;
    },
    remove() {
      return spawn("secret-tool", ["clear", ...attributes]).status === 0;
    },
  };
}

export function fileDistKeyStore(supportDirectory: string): DistKeyStore {
  const path = distKeyPath(supportDirectory);
  return {
    where: `${path} (not encrypted)`,
    encrypted: false,
    read() {
      try {
        return readFileSync(path, "utf8").trim() || null;
      } catch {
        return null;
      }
    },
    write(key) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${key}\n`, { mode: 0o600 });
      return true;
    },
    remove() {
      const existed = existsSync(path);
      rmSync(path, { force: true });
      return existed;
    },
  };
}

/** Encrypted stores first, the file last; every store is read so a key saved before a store appeared is still found. */
function distKeyStores(deps: ScoutWebCommandDeps, env: NodeJS.ProcessEnv): DistKeyStore[] {
  if (deps.keyStores) return deps.keyStores;
  const stores: DistKeyStore[] = [];
  if (process.platform === "darwin") stores.push(keychainDistKeyStore());
  else if (env.DBUS_SESSION_BUS_ADDRESS && spawnText("secret-tool", ["--version"]).status !== null) {
    stores.push(secretServiceDistKeyStore());
  }
  stores.push(fileDistKeyStore(supportDirectoryOf(deps)));
  return stores;
}

function readSavedKey(stores: DistKeyStore[]): { key: string; store: DistKeyStore } | null {
  for (const store of stores) {
    const key = store.read();
    if (key) return { key, store };
  }
  return null;
}

function resolveKey(context: ScoutCommandContext, stores: DistKeyStore[]): { key: string; where: string } | null {
  const fromEnv = context.env.SCOUT_DIST_KEY?.trim();
  if (fromEnv) return { key: fromEnv, where: "SCOUT_DIST_KEY" };
  const saved = readSavedKey(stores);
  return saved ? { key: saved.key, where: saved.store.where } : null;
}

function readFlagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    const value = args[index + 1];
    if (value === undefined || (value.startsWith("--") && value !== "-")) {
      throw new ScoutCliError(`${name} needs a value`);
    }
    return value;
  }
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// Asks for the key without echoing it, so it stays out of shell history and
// off the screen.
async function promptHiddenKey(): Promise<string> {
  process.stderr.write("Download key: ");
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    return await new Promise<string>((resolve) => rl.once("line", resolve));
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

async function distRequest(
  context: ScoutCommandContext,
  deps: ScoutWebCommandDeps,
  key: string,
  path: string,
  timeoutMs = 15_000,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${distBaseUrl(context.env)}${path}`;
  try {
    return await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json, application/gzip" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ScoutCliError(`Couldn't reach ${distBaseUrl(context.env)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function explainFailure(status: number, body: { error?: string } | null): string {
  if (status === 401) return "The download key was not accepted. It may be revoked; make a new one at https://console.openscout.app/#downloads.";
  if (status === 403) return "This account doesn't have the full web app.";
  if (status === 404 && body?.error === "not_published") return "not_published";
  return `The download host answered ${status}${body?.error ? ` (${body.error})` : ""}.`;
}

/* ------------------------------------------------------------------ */

async function runLogin(context: ScoutCommandContext, args: string[], deps: ScoutWebCommandDeps): Promise<void> {
  let key = readFlagValue(args, "--key");
  if (key === "-" || (key === undefined && !(context.isTty && process.stdin.isTTY))) {
    key = (await (deps.readStdin ?? readAllStdin)()).trim();
  } else if (key === undefined) {
    key = (await (deps.promptKey ?? promptHiddenKey)()).trim();
  }
  if (!key) throw new ScoutCliError("No key given. Make one at https://console.openscout.app/#downloads, then: scout web login");
  if (!key.startsWith(DIST_KEY_PREFIX)) throw new ScoutCliError(`That isn't a download key; they start with ${DIST_KEY_PREFIX}.`);

  const response = await distRequest(context, deps, key, "/v1/dist/whoami");
  const body = await response.json().catch(() => null) as { login?: string | null; label?: string | null; error?: string } | null;
  if (!response.ok) throw new ScoutCliError(explainFailure(response.status, body));

  // Save to the first store that takes it, then clear the rest so no stale
  // copy outlives a logout.
  const stores = distKeyStores(deps, context.env);
  const saved = stores.find((store) => store.write(key));
  if (!saved) throw new ScoutCliError("Couldn't save the download key.");
  for (const store of stores) if (store !== saved) store.remove();
  const who = body?.login ? ` as ${body.login}` : "";
  const label = body?.label ? ` (key "${body.label}")` : "";
  context.output.writeText(`Signed in${who}${label}. Key saved in ${saved.where}.\nNext: scout web install`);
}

function runLogout(context: ScoutCommandContext, deps: ScoutWebCommandDeps): void {
  const removed = distKeyStores(deps, context.env).map((store) => store.remove()).some(Boolean);
  context.output.writeText(removed ? "Download key removed." : "No saved download key.");
}

async function defaultRestartWeb(): Promise<string> {
  const status = await requestScoutWebControl("restart");
  return status.webUrl;
}

async function runInstall(context: ScoutCommandContext, args: string[], deps: ScoutWebCommandDeps): Promise<void> {
  const supportDirectory = supportDirectoryOf(deps);
  const version = readFlagValue(args, "--version") ?? deps.version ?? SCOUT_APP_VERSION;
  const resolved = resolveKey(context, distKeyStores(deps, context.env));
  if (!resolved) {
    throw new ScoutCliError("No download key. Make one at https://console.openscout.app/#downloads, then: scout web login");
  }

  const target = webFullClientDirectory(version, supportDirectory);
  if (!args.includes("--force") && resolveInstalledWebFullClient(version, { env: {}, supportDirectory })) {
    context.output.writeText(`The full web app ${version} is already installed. --force reinstalls it.`);
    return;
  }

  const response = await distRequest(context, deps, resolved.key, `/v1/dist/web-full/${encodeURIComponent(version)}`, DOWNLOAD_TIMEOUT_MS);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    const reason = explainFailure(response.status, body);
    throw new ScoutCliError(reason === "not_published"
      ? `The full web app isn't published for Scout ${version} yet.`
      : reason);
  }
  const expected = response.headers.get("x-openscout-sha256")?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new ScoutCliError("The download came without a checksum; not installing it.");
  if (!response.body) throw new ScoutCliError("The download was empty.");

  const root = webFullClientsDirectory(supportDirectory);
  mkdirSync(root, { recursive: true });
  const workDirectory = join(root, `.install-${process.pid}-${Date.now()}`);
  mkdirSync(workDirectory, { recursive: true });
  try {
    const tarball = join(workDirectory, "web-full.tar.gz");
    const hash = createHash("sha256");
    const source = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(source, createWriteStream(tarball));
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new ScoutCliError(`Checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…); not installing.`);
    }

    const unpacked = join(workDirectory, "client");
    mkdirSync(unpacked, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", tarball, "-C", unpacked], { encoding: "utf8" });
    if (tar.status !== 0) throw new ScoutCliError(`Couldn't unpack the download: ${(tar.stderr || tar.error?.message || "tar failed").trim()}`);
    const profile = readWebFullClientProfile(unpacked);
    if (!existsSync(join(unpacked, "index.html")) || profile?.version !== version) {
      throw new ScoutCliError(`The download isn't the full web app for ${version}; not installing it.`);
    }

    // Swap in place: the old copy (if any) moves aside before the new one lands.
    const previous = existsSync(target) ? join(workDirectory, "previous") : null;
    if (previous) renameSync(target, previous);
    try {
      renameSync(unpacked, target);
    } catch (error) {
      if (previous) renameSync(previous, target);
      throw error;
    }
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }

  // Only the installed CLI's version is ever served; older copies are dead weight.
  for (const entry of readdirSync(root)) {
    if (entry !== version && !entry.startsWith(".")) rmSync(join(root, entry), { recursive: true, force: true });
  }

  context.output.writeText(`Installed the full web app ${version} → ${target}`);
  if (args.includes("--no-restart")) {
    context.output.writeText("Restart Scout's web server to serve it: scout server restart");
    return;
  }
  try {
    const url = await (deps.restartWeb ?? defaultRestartWeb)();
    context.output.writeText(`Restarted Scout web; the full app is at ${url}`);
  } catch (error) {
    context.output.writeText(`Installed, but Scout's web server didn't restart (${error instanceof Error ? error.message : String(error)}). Run: scout server restart`);
  }
}

function runUninstall(context: ScoutCommandContext, deps: ScoutWebCommandDeps): void {
  const root = webFullClientsDirectory(supportDirectoryOf(deps));
  const existed = existsSync(root) && readdirSync(root).some((entry) => !entry.startsWith("."));
  rmSync(root, { recursive: true, force: true });
  context.output.writeText(existed
    ? "Removed the full web app. Restart Scout's web server to go back to basic: scout server restart"
    : "The full web app isn't installed.");
}

async function runStatus(context: ScoutCommandContext, deps: ScoutWebCommandDeps): Promise<void> {
  const supportDirectory = supportDirectoryOf(deps);
  const version = deps.version ?? SCOUT_APP_VERSION;
  const key = resolveKey(context, distKeyStores(deps, context.env));
  const installed = resolveInstalledWebFullClient(version, { env: context.env, supportDirectory });
  const status = {
    version,
    downloadHost: distBaseUrl(context.env),
    key: key?.where ?? null,
    installed,
    serves: installed ? "full" : "basic",
  };
  context.output.writeValue(status, (value) => [
    `Scout ${value.version}`,
    `key        ${value.key ?? "none (scout web login)"}`,
    `installed  ${value.installed ?? "no"}`,
    `serves     ${value.serves === "full" ? "the full web app" : "the basic web app (Home, DMs, Tail)"}`,
  ].join("\n"));
}

export async function runWebCommand(
  context: ScoutCommandContext,
  args: string[],
  deps: ScoutWebCommandDeps = {},
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h" || rest.includes("--help")) {
    context.output.writeText(renderWebCommandHelp());
    return;
  }
  switch (subcommand) {
    case "login":
      return runLogin(context, rest, deps);
    case "logout":
      return runLogout(context, deps);
    case "install":
      return runInstall(context, rest, deps);
    case "uninstall":
      return runUninstall(context, deps);
    case "status":
      return runStatus(context, deps);
    default:
      throw new ScoutCliError(`unknown subcommand: scout web ${subcommand}; see scout web --help`);
  }
}
