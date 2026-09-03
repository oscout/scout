import type { RuntimeChildProcessLike, RuntimeEnv, RuntimeHttpRequestLike, RuntimeSpawnFunction } from "./portable-types.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScoutBrokerChildServiceSnapshots } from "./broker-api.js";
import { resolveBrokerServiceConfig } from "./broker-process-manager.js";
import { resolveWebAuthToken, resolveWebPort } from "./local-config.js";
import {
  resolveBunExecutable,
  resolveOpenScoutRepoRoot,
  resolveRepoEntrypoint,
} from "./tool-resolution.js";

export type WebControlStatus = {
  ok: boolean;
  running: boolean;
  starting: boolean;
  managed: boolean;
  webUrl: string;
  port: number;
  pid: number | null;
  error: string | null;
};

export type WebStartContext = {
  publicOrigin?: string;
  trustedHost?: string;
};

type BunExecutable = {
  path: string;
};

export type BrokerWebControlServiceOptions = {
  brokerControlUrl: string;
  tailnetWebHosts?: string[];
  trustedHosts?: Iterable<string>;
  webProcessName?: string;
  env?: RuntimeEnv;
  fetch?: typeof fetch;
  spawnProcess?: RuntimeSpawnFunction<RuntimeChildProcessLike>;
  moduleDirectory?: string;
  cwd?: () => string;
  sleep?: (ms: number) => Promise<void>;
  healthCheck?: (webUrl: string) => Promise<boolean>;
  resolveEntry?: () => string | null;
  resolveBun?: () => BunExecutable | null;
  resolveLogPath?: () => string;
  resolveWebPort?: () => number;
  startPollTimeoutMs?: number;
  startPollIntervalMs?: number;
  respawnBaseDelayMs?: number;
  respawnMaxDelayMs?: number;
  respawnMaxFailures?: number;
  respawnFailureWindowMs?: number;
  stopTimeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
  warn?: (message: string) => void;
  error?: (message: string, detail?: unknown) => void;
};

const DEFAULT_WEB_PROCESS_NAME = "scout-web";
const DEFAULT_START_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_START_POLL_INTERVAL_MS = 250;
const DEFAULT_RESPAWN_BASE_DELAY_MS = 1_000;
const DEFAULT_RESPAWN_MAX_DELAY_MS = 30_000;
const DEFAULT_RESPAWN_MAX_FAILURES = 5;
const DEFAULT_RESPAWN_FAILURE_WINDOW_MS = 60_000;
// Keep this below the broker's outer shutdown allowance. The web server has
// its own drain window, so clearing our child handle immediately after TERM
// would make a replacement or parent shutdown race the still-live process.
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export function appendCsvValue(input: string | undefined, value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return input;
  }
  const existing = (input ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!existing.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
    existing.push(normalized);
  }
  return existing.length > 0 ? existing.join(",") : undefined;
}

export function appendCsvValues(input: string | undefined, values: Array<string | undefined>): string | undefined {
  return values.reduce((current, value) => appendCsvValue(current, value), input);
}

export function normalizeTrustedWebHost(
  value: string | undefined,
  trustedHosts: Set<string> = new Set(),
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const candidate = trimmed.includes("://") ? new URL(trimmed) : new URL(`http://${trimmed}`);
    const hostName = candidate.hostname.toLowerCase();
    if (
      hostName === "scout.local"
      || hostName.endsWith(".scout.local")
      || hostName === "localhost"
      || hostName === "127.0.0.1"
      || hostName === "::1"
      || trustedHosts.has(hostName)
    ) {
      return hostName;
    }
  } catch {
    return null;
  }
  return null;
}

export function webStartContextFromRequest(
  request: Pick<RuntimeHttpRequestLike, "headers">,
  trustedHosts: Set<string> = new Set(),
): WebStartContext {
  const forwardedHost = Array.isArray(request.headers["x-forwarded-host"])
    ? request.headers["x-forwarded-host"][0]
    : request.headers["x-forwarded-host"];
  const forwardedProto = Array.isArray(request.headers["x-forwarded-proto"])
    ? request.headers["x-forwarded-proto"][0]
    : request.headers["x-forwarded-proto"];
  const trustedHost = normalizeTrustedWebHost(forwardedHost, trustedHosts);
  if (!trustedHost) {
    return {};
  }
  const proto = forwardedProto?.trim().toLowerCase() === "https" ? "https" : "http";
  return {
    publicOrigin: `${proto}://${trustedHost}`,
    trustedHost,
  };
}

export function scoutWebControlCorsHeaders(
  request: Pick<RuntimeHttpRequestLike, "headers">,
  trustedHosts: Set<string> = new Set(),
): Record<string, string> {
  const origin = request.headers.origin;
  if (typeof origin !== "string") {
    return {};
  }
  const allowed = Boolean(normalizeTrustedWebHost(origin, trustedHosts));
  if (!allowed) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function isChildProcessRunning(
  child: RuntimeChildProcessLike | null,
): child is RuntimeChildProcessLike {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

export class BrokerWebControlService {
  private readonly env: RuntimeEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: RuntimeSpawnFunction<RuntimeChildProcessLike>;
  private readonly trustedHosts: Set<string>;
  private readonly tailnetWebHosts: string[];
  private readonly webProcessName: string;
  private readonly moduleDirectory: string;
  private readonly cwd: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startPollTimeoutMs: number;
  private readonly startPollIntervalMs: number;
  private readonly respawnBaseDelayMs: number;
  private readonly respawnMaxDelayMs: number;
  private readonly respawnMaxFailures: number;
  private readonly respawnFailureWindowMs: number;
  private readonly stopTimeoutMs: number;
  private readonly webAuthToken: string;
  private readonly respawnFailures: number[] = [];
  private webServerProcess: RuntimeChildProcessLike | null = null;
  private webStartInFlight: Promise<WebControlStatus> | null = null;
  private webRestartInFlight: Promise<WebControlStatus> | null = null;
  private stopping = false;

  constructor(private readonly options: BrokerWebControlServiceOptions) {
    this.env = options.env ?? process.env;
    this.webAuthToken = this.env.OPENSCOUT_WEB_AUTH_TOKEN?.trim()
      || resolveWebAuthToken(this.env);
    this.fetchImpl = options.fetch ?? fetch;
    this.spawnImpl = options.spawnProcess ?? (spawn as unknown as RuntimeSpawnFunction<RuntimeChildProcessLike>);
    this.trustedHosts = new Set(
      [...(options.trustedHosts ?? [])]
        .map((host) => host.trim().replace(/\.$/, "").toLowerCase())
        .filter(Boolean),
    );
    this.tailnetWebHosts = (options.tailnetWebHosts ?? []).map((host) => host.trim()).filter(Boolean);
    this.webProcessName = options.webProcessName ?? DEFAULT_WEB_PROCESS_NAME;
    this.moduleDirectory = options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
    this.cwd = options.cwd ?? (() => process.cwd());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.startPollTimeoutMs = options.startPollTimeoutMs ?? DEFAULT_START_POLL_TIMEOUT_MS;
    this.startPollIntervalMs = options.startPollIntervalMs ?? DEFAULT_START_POLL_INTERVAL_MS;
    this.respawnBaseDelayMs = options.respawnBaseDelayMs ?? DEFAULT_RESPAWN_BASE_DELAY_MS;
    this.respawnMaxDelayMs = options.respawnMaxDelayMs ?? DEFAULT_RESPAWN_MAX_DELAY_MS;
    this.respawnMaxFailures = options.respawnMaxFailures ?? DEFAULT_RESPAWN_MAX_FAILURES;
    this.respawnFailureWindowMs = options.respawnFailureWindowMs ?? DEFAULT_RESPAWN_FAILURE_WINDOW_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  port(): number {
    const envPort = Number.parseInt(this.env.OPENSCOUT_WEB_PORT ?? "", 10);
    return Number.isInteger(envPort) && envPort > 0 && envPort < 65536
      ? envPort
      : (this.options.resolveWebPort ?? resolveWebPort)();
  }

  url(): string {
    return `http://127.0.0.1:${this.port()}`;
  }

  async status(error: string | null = null): Promise<WebControlStatus> {
    const running = await this.isHealthy();
    const managed = isChildProcessRunning(this.webServerProcess);
    return {
      ok: running,
      running,
      starting: Boolean(this.webStartInFlight),
      managed,
      webUrl: this.url(),
      port: this.port(),
      pid: managed ? this.webServerProcess?.pid ?? null : null,
      error,
    };
  }

  failureStatus(error: unknown): WebControlStatus {
    const managed = isChildProcessRunning(this.webServerProcess);
    return {
      ok: false,
      running: false,
      starting: false,
      managed,
      webUrl: this.url(),
      port: this.port(),
      pid: managed ? this.webServerProcess?.pid ?? null : null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  readChildServiceSnapshots(): ScoutBrokerChildServiceSnapshots {
    const webRunning = isChildProcessRunning(this.webServerProcess);
    return {
      web: {
        managed: true,
        managedBy: "broker",
        state: this.webStartInFlight ? "starting" : webRunning ? "running" : "stopped",
        pid: this.webServerProcess?.pid ?? null,
        port: this.port(),
        url: this.url(),
        healthy: null,
        detail: this.webStartInFlight
          ? "web startup is in flight"
          : webRunning
            ? "web child process is active; broker /health does not probe /api/health"
            : "web child has not been started by this broker",
      },
      terminalRelay: {
        managed: true,
        managedBy: "web",
        state: "unknown",
        pid: null,
        healthy: null,
        detail: "terminal relay is managed inside scout-web; broker /health does not probe it",
      },
      localEdge: {
        managed: true,
        managedBy: "base",
        state: "unknown",
        pid: null,
        healthy: null,
        detail: "local edge/Caddy is managed by scout-base; no broker-visible cached state is available",
      },
    };
  }

  startContextFromRequest(request: Pick<RuntimeHttpRequestLike, "headers">): WebStartContext {
    return webStartContextFromRequest(request, this.trustedHosts);
  }

  corsHeaders(request: Pick<RuntimeHttpRequestLike, "headers">): Record<string, string> {
    return scoutWebControlCorsHeaders(request, this.trustedHosts);
  }

  async startIfNeeded(context: WebStartContext = {}): Promise<WebControlStatus> {
    if (this.stopping) {
      return this.failureStatus("Scout web cannot start while the broker is stopping.");
    }
    if (this.webStartInFlight) {
      return this.webStartInFlight;
    }

    this.webStartInFlight = (async () => {
      try {
        if (await this.isHealthy()) {
          return this.status();
        }
        // stop() can run while the initial health probe is in flight. Recheck
        // the lifecycle boundary after that await so shutdown cannot return
        // before a late web child is spawned.
        if (this.stopping) {
          return this.failureStatus("Scout web cannot start while the broker is stopping.");
        }
        if (!isChildProcessRunning(this.webServerProcess)) {
          this.webServerProcess = this.spawnWebServer(context);
        }
        const deadline = Date.now() + this.startPollTimeoutMs;
        while (Date.now() < deadline) {
          if (await this.isHealthy()) {
            return this.status();
          }
          await this.sleep(this.startPollIntervalMs);
        }
        return this.status("Timed out waiting for Scout web to become healthy.");
      } catch (error) {
        return this.status(error instanceof Error ? error.message : String(error));
      } finally {
        this.webStartInFlight = null;
      }
    })();

    return this.webStartInFlight;
  }

  /**
   * Restart only a web process this broker launched. An already-healthy process
   * with no child handle is deliberately not adopted: it may belong to another
   * terminal or a previous broker, and killing it would violate process
   * ownership.
   */
  async restartIfManaged(context: WebStartContext = {}): Promise<WebControlStatus> {
    if (this.webRestartInFlight) {
      return this.webRestartInFlight;
    }

    this.webRestartInFlight = (async () => {
      const child = this.webServerProcess;
      if (!isChildProcessRunning(child)) {
        if (await this.isHealthy()) {
          return {
            ...await this.status(),
            ok: false,
            error: "Scout web is running outside broker management and cannot be restarted safely. Stop that process, then run `scout server start`.",
          };
        }
        return this.startIfNeeded(context);
      }

      let signalled = false;
      try {
        signalled = child.kill("SIGTERM");
      } catch (error) {
        return {
          ...await this.status(),
          ok: false,
          error: `Could not signal the broker-managed Scout web process: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!signalled) {
        return {
          ...await this.status(),
          ok: false,
          error: "Could not signal the broker-managed Scout web process to stop.",
        };
      }

      // Clear the handle only after signalling succeeds, so the child exit
      // listener cannot schedule an independent respawn alongside this restart.
      this.webServerProcess = null;

      const deadline = Date.now() + this.startPollTimeoutMs;
      while (Date.now() < deadline) {
        // Wait for the owned process itself to exit, not merely for its health
        // route to turn false. The Bun server drains after SIGTERM while it
        // still owns the port; spawning on health failure alone races the
        // replacement into EADDRINUSE.
        if (!isChildProcessRunning(child)) {
          return this.startIfNeeded(context);
        }
        await this.sleep(this.startPollIntervalMs);
      }
      if (isChildProcessRunning(child)) {
        this.webServerProcess = child;
      }
      return {
        ...await this.status(),
        ok: false,
        error: "Timed out waiting for the broker-managed Scout web process to stop.",
      };
    })().finally(() => {
      this.webRestartInFlight = null;
    });

    return this.webRestartInFlight;
  }

  /**
   * Stop only the web process this broker launched. This deliberately awaits
   * the owned child before releasing its handle, giving the parent a real
   * shutdown boundary rather than a best-effort signal.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.webServerProcess;
    if (!isChildProcessRunning(child)) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch (error) {
      this.options.warn?.(`[openscout-runtime] could not stop broker-managed Scout web: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const deadline = Date.now() + this.stopTimeoutMs;
    while (isChildProcessRunning(child) && Date.now() < deadline) {
      await this.sleep(this.startPollIntervalMs);
    }
    if (isChildProcessRunning(child)) {
      this.options.warn?.(`[openscout-runtime] Scout web did not exit within ${this.stopTimeoutMs}ms; forcing broker-managed child shutdown.`);
      try {
        child.kill("SIGKILL");
      } catch {
        // Preserve the handle below if the process still appears alive.
      }
      const forceDeadline = Date.now() + 2_000;
      while (isChildProcessRunning(child) && Date.now() < forceDeadline) {
        await this.sleep(this.startPollIntervalMs);
      }
    }
    if (!isChildProcessRunning(child) && this.webServerProcess === child) {
      this.webServerProcess = null;
    }
  }

  private async isHealthy(): Promise<boolean> {
    if (this.options.healthCheck) {
      return this.options.healthCheck(this.url());
    }
    try {
      const response = await this.fetchImpl(`${this.url()}/api/health`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.webAuthToken}`,
        },
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) {
        return false;
      }
      const body = await response.json() as { ok?: boolean; surface?: string };
      return body.ok === true && body.surface === "openscout-web";
    } catch {
      return false;
    }
  }

  private resolveEntry(): string | null {
    if (this.options.resolveEntry) {
      return this.options.resolveEntry();
    }
    const explicit = this.env.OPENSCOUT_WEB_SERVER_ENTRY?.trim();
    if (explicit && existsSync(explicit)) {
      return explicit;
    }

    const repoRoot = this.resolveRepoRoot();
    const repoEntry = resolveRepoEntrypoint(repoRoot, "packages/web/server/index.ts");
    if (repoEntry) {
      return repoEntry;
    }

    const candidates = [
      resolve(this.moduleDirectory, "..", "scout-control-plane-web.mjs"),
      resolve(this.moduleDirectory, "..", "scout-web-server.mjs"),
      resolve(this.moduleDirectory, "..", "..", "scout-control-plane-web.mjs"),
      resolve(this.moduleDirectory, "..", "..", "scout-web-server.mjs"),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  private resolveRepoRoot(): string | null {
    return resolveOpenScoutRepoRoot({
      startDirectories: [
        this.env.OPENSCOUT_SETUP_CWD,
        this.cwd(),
        this.moduleDirectory,
      ],
    });
  }

  private resolveSetupCwd(): string {
    return this.env.OPENSCOUT_SETUP_CWD?.trim() || this.resolveRepoRoot() || this.cwd();
  }

  private resolveLogPath(): string {
    if (this.options.resolveLogPath) {
      return this.options.resolveLogPath();
    }
    const config = resolveBrokerServiceConfig();
    const logDirectory = join(config.supportDirectory, "logs", "web");
    mkdirSync(logDirectory, { recursive: true });
    return join(logDirectory, "supervised-web.log");
  }

  private spawnWebServer(context: WebStartContext = {}): RuntimeChildProcessLike {
    const entry = this.resolveEntry();
    if (!entry) {
      throw new Error("Could not find the Scout web server entry.");
    }
    const bun = this.options.resolveBun ? this.options.resolveBun() : resolveBunExecutable();
    if (!bun) {
      throw new Error("Unable to locate Bun for Scout web startup.");
    }

    const logFd = openSync(this.resolveLogPath(), "a");
    const trustedHosts = appendCsvValues(this.env.OPENSCOUT_WEB_TRUSTED_HOSTS, [
      ...this.tailnetWebHosts,
      context.trustedHost,
    ]);
    // The supervised service owns the always-on Bonjour `/pair` ingress. Its
    // default listener is reachable on the LAN, but the web socket boundary
    // admits only exact GET /pair from non-loopback peers. An operator-provided
    // bind host remains an explicit configuration and must carry its own LAN
    // opt-in when non-loopback.
    const configuredBindHost = this.env.OPENSCOUT_WEB_HOST?.trim()
      || this.env.SCOUT_WEB_HOST?.trim()
      || null;
    const brokerPairingIngress = configuredBindHost === null;
    const env = {
      ...this.env,
      OPENSCOUT_WEB_HOST: configuredBindHost ?? "0.0.0.0",
      ...(brokerPairingIngress
        ? {
            OPENSCOUT_WEB_ALLOW_LAN: "1",
            OPENSCOUT_WEB_LAN_SCOPE: this.env.OPENSCOUT_WEB_LAN_SCOPE?.trim() || "pairing",
          }
        : {}),
      OPENSCOUT_WEB_PORT: String(this.port()),
      OPENSCOUT_WEB_BUN_URL: this.url(),
      OPENSCOUT_WEB_AUTH_TOKEN: this.webAuthToken,
      OPENSCOUT_BROKER_INTERNAL_URL: this.options.brokerControlUrl,
      OPENSCOUT_PARENT_PID: String(process.pid),
      ...(context.publicOrigin && !this.env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim()
        ? { OPENSCOUT_WEB_PUBLIC_ORIGIN: context.publicOrigin }
        : {}),
      ...(context.trustedHost && context.trustedHost !== "scout.local" && !this.env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
        ? { OPENSCOUT_WEB_ADVERTISED_HOST: context.trustedHost }
        : {}),
      ...(trustedHosts ? { OPENSCOUT_WEB_TRUSTED_HOSTS: trustedHosts } : {}),
      OPENSCOUT_SETUP_CWD: this.resolveSetupCwd(),
    };
    this.options.log?.("[openscout-runtime] starting Scout web server", {
      webUrl: this.url(),
      publicOrigin: env.OPENSCOUT_WEB_PUBLIC_ORIGIN,
      advertisedHost: env.OPENSCOUT_WEB_ADVERTISED_HOST,
      brokerInternalUrl: env.OPENSCOUT_BROKER_INTERNAL_URL,
      trustedHost: context.trustedHost,
    });
    const child = this.spawnImpl(
      bun.path,
      ["run", entry],
      {
        argv0: this.webProcessName,
        env,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.once("exit", (code, signal) => {
      if (this.webServerProcess !== child) {
        // Either we already replaced this handle, or shutdown nulled it intentionally.
        return;
      }
      this.webServerProcess = null;
      if (this.stopping) {
        return;
      }
      // Track failures within a sliding window so a broken entrypoint doesn't
      // produce an infinite respawn loop. Linear backoff escalates the delay
      // with each consecutive failure; we pause auto-respawn entirely once we
      // exceed the threshold and require an operator to call `scout server start`.
      const now = Date.now();
      while (this.respawnFailures.length > 0 && now - this.respawnFailures[0]! > this.respawnFailureWindowMs) {
        this.respawnFailures.shift();
      }
      this.respawnFailures.push(now);
      if (this.respawnFailures.length > this.respawnMaxFailures) {
        this.options.error?.(
          `[openscout-runtime] Scout web server has exited ${this.respawnFailures.length} times within ${this.respawnFailureWindowMs / 1000}s - pausing auto-respawn. Use 'scout server start' to retry.`,
        );
        this.respawnFailures.length = 0;
        return;
      }
      const delay = Math.min(
        this.respawnBaseDelayMs * this.respawnFailures.length,
        this.respawnMaxDelayMs,
      );
      this.options.warn?.(
        `[openscout-runtime] Scout web server exited unexpectedly (code=${code}, signal=${signal}) - respawning in ${delay}ms (failure ${this.respawnFailures.length}/${this.respawnMaxFailures})`,
      );
      setTimeout(() => {
        if (this.stopping) return;
        this.startIfNeeded(context).catch((error) => {
          this.options.error?.("[openscout-runtime] web server respawn failed:", error);
        });
      }, delay).unref?.();
    });
    child.unref();
    return child;
  }
}
