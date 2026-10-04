// The download key `scout web login` saves, and the one question Scout can ask
// the download host with it: does this account have the full web app?
//
// The CLI (`scout web`) and the web server's Solo Pro read model share this so
// there is one place that knows where the key lives and how whoami answers.
// The key itself never leaves this module: callers get where it is stored,
// never what it is.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCOUT_DIST_DEFAULT_URL = "https://console.openscout.app";
export const SCOUT_DIST_KEYS_URL = "https://console.openscout.app/#downloads";
export const DIST_KEY_PREFIX = "osdist_";
export const DIST_KEY_KEYCHAIN_SERVICE = "OPENSCOUT_DIST_KEY";

export function distBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.OPENSCOUT_DIST_URL?.trim() || SCOUT_DIST_DEFAULT_URL).replace(/\/+$/, "");
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

export type SpawnText = (command: string, args: string[], input?: string) => { status: number | null; stdout: string };

const spawnText: SpawnText = (command, args, input) => {
  const result = spawnSync(command, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
};

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
export function defaultDistKeyStores(supportDirectory: string, env: NodeJS.ProcessEnv = process.env): DistKeyStore[] {
  const stores: DistKeyStore[] = [];
  if (process.platform === "darwin") stores.push(keychainDistKeyStore());
  else if (env.DBUS_SESSION_BUS_ADDRESS && spawnText("secret-tool", ["--version"]).status !== null) {
    stores.push(secretServiceDistKeyStore());
  }
  stores.push(fileDistKeyStore(supportDirectory));
  return stores;
}

export function readSavedDistKey(stores: DistKeyStore[]): { key: string; store: DistKeyStore } | null {
  for (const store of stores) {
    const key = store.read();
    if (key) return { key, store };
  }
  return null;
}

/** SCOUT_DIST_KEY first, then the saved key, the same order `scout web` uses. */
export function resolveDistKey(env: NodeJS.ProcessEnv, stores: DistKeyStore[]): { key: string; where: string } | null {
  const fromEnv = env.SCOUT_DIST_KEY?.trim();
  if (fromEnv) return { key: fromEnv, where: "SCOUT_DIST_KEY" };
  const saved = readSavedDistKey(stores);
  return saved ? { key: saved.key, where: saved.store.where } : null;
}

/* ── access ─────────────────────────────────────────────────────────────── */

/**
 * What the download host said about this account's full web app, as of one
 * explicit check. Only `granted` and `denied` are answers about the account;
 * every other state means Scout does not know, and must not be read as either.
 */
export type ExpandedWebAccess =
  | { state: "unchecked" }
  | { state: "granted"; checkedAt: number; keyWhere: string; account: { login: string; label: string | null } }
  | { state: "denied"; checkedAt: number; keyWhere: string }
  | { state: "no_credential"; checkedAt: number }
  | { state: "credential_rejected"; checkedAt: number; keyWhere: string }
  | { state: "unavailable"; checkedAt: number; keyWhere: string; reason: string };

export type ExpandedWebAccessState = ExpandedWebAccess["state"];

export type CheckExpandedWebAccessOptions = {
  env?: NodeJS.ProcessEnv;
  stores: DistKeyStore[];
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  now?: () => number;
};

function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[key]") : text;
}

/**
 * Asks `GET /v1/dist/whoami` with the saved download key. The host checks the
 * account's entitlement on every call: 200 when it has the full web app, 403
 * `not_entitled` when it doesn't, 401 when the key is revoked or unknown.
 * This makes one network request; call it only when someone asks.
 */
export async function checkExpandedWebAccess(options: CheckExpandedWebAccessOptions): Promise<ExpandedWebAccess> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const resolved = resolveDistKey(env, options.stores);
  if (!resolved) return { state: "no_credential", checkedAt: now() };
  const { key, where } = resolved;
  const host = distBaseUrl(env);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${host}/v1/dist/whoami`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { state: "unavailable", checkedAt: now(), keyWhere: where, reason: scrub(`Couldn't reach ${host}: ${detail}`, key) };
  }
  const body = await response.json().catch(() => null) as { login?: unknown; label?: unknown; error?: unknown } | null;
  if (response.status === 200 && typeof body?.login === "string" && body.login) {
    return {
      state: "granted",
      checkedAt: now(),
      keyWhere: where,
      account: { login: body.login, label: typeof body.label === "string" && body.label ? body.label : null },
    };
  }
  if (response.status === 403 && body?.error === "not_entitled") return { state: "denied", checkedAt: now(), keyWhere: where };
  if (response.status === 401) return { state: "credential_rejected", checkedAt: now(), keyWhere: where };
  // A 200 without an account, a 403 for some other reason, a 5xx: none of these
  // say what the account has.
  const error = typeof body?.error === "string" ? ` (${body.error})` : "";
  return {
    state: "unavailable",
    checkedAt: now(),
    keyWhere: where,
    reason: scrub(`${host} answered ${response.status}${error}.`, key),
  };
}
