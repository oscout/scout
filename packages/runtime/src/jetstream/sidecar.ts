import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { ScoutBrokerChildServiceSnapshot } from "../broker-api.js";
import {
  jetStreamMonitorUrl,
  jetStreamServerUrl,
  type JetStreamRuntimeConfig,
} from "./config.js";

export type JetStreamSidecarOptions = {
  config: JetStreamRuntimeConfig;
  spawnProcess?: typeof spawn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, detail?: unknown) => void;
  warn?: (message: string, detail?: unknown) => void;
  error?: (message: string, detail?: unknown) => void;
};

export class JetStreamBinaryMissingError extends Error {
  constructor(binary: string) {
    super(
      `nats-server binary "${binary}" was not found on PATH.\n`
        + "OpenScout's JetStream sidecar is opt-in and does not install it.\n"
        + "Install it (`brew install nats-server`) or point "
        + "OPENSCOUT_JETSTREAM_BINARY at an existing executable, then restart the service.",
    );
    this.name = "JetStreamBinaryMissingError";
  }
}

export class JetStreamPortOccupiedError extends Error {
  constructor(url: string, pidPath: string) {
    super(
      `Something is already listening on ${url}.\n`
        + "OpenScout will not adopt, reconfigure, restart, or signal a NATS server it did "
        + "not start, and it will not infer ownership from a pid file: a recorded pid can "
        + "name a recycled, unrelated process.\n"
        + "If this is an orphan from a previous run, confirm it yourself before acting:\n"
        + `  lsof -nP -iTCP:${url.split(":").pop()} -sTCP:LISTEN\n`
        + `  cat ${pidPath}\n`
        + "Then stop that process, choose another OPENSCOUT_JETSTREAM_PORT, or set "
        + "OPENSCOUT_JETSTREAM_MANAGE_SERVER=0 to deliberately attach to a server you manage.",
    );
    this.name = "JetStreamPortOccupiedError";
  }
}

const RESPAWN_BASE_DELAY_MS = 500;
const RESPAWN_MAX_DELAY_MS = 15_000;
const RESPAWN_MAX_FAILURES = 5;
const RESPAWN_FAILURE_WINDOW_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

/** Resolve `nats-server` the way a shell would, without running a shell. */
export function resolveNatsServerBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (binary.includes("/")) {
    const path = isAbsolute(binary) ? binary : join(process.cwd(), binary);
    return isExecutable(path) ? path : null;
  }
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function probeTcpPort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

type SidecarState = "stopped" | "starting" | "running" | "external" | "failed";

/**
 * A `nats-server` child owned by this process.
 *
 * It supervises only the child it spawned, held as a live process handle. An
 * operator's own nats-server — launchd, brew services, a terminal — is never
 * signalled, reconfigured, or adopted: a busy port is a hard, actionable error.
 *
 * Deliberately no pid-file reclamation. A pid read from a file proves nothing
 * about what is running under that number now: the recorded process may have
 * exited and the pid been reused by something unrelated, or a second live
 * supervisor may be pointed at the same data directory. Signalling on that
 * evidence risks killing an innocent process, so an orphan left by a SIGKILLed
 * parent surfaces as an occupied port with manual diagnosis instructions
 * instead. Automatic reclamation needs proof of process identity (start time
 * plus executable) and is deferred past this slice.
 */
export class NatsJetStreamSidecar {
  private child: ChildProcess | null = null;
  /** Pid of the child this instance spawned; the only pid it may ever signal. */
  private spawnedPid: number | null = null;
  private state: SidecarState = "stopped";
  private detail: string | null = null;
  private stopping = false;
  private respawnTimer: NodeJS.Timeout | null = null;
  private recentFailures: number[] = [];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: JetStreamSidecarOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  get config(): JetStreamRuntimeConfig {
    return this.options.config;
  }

  url(): string {
    return jetStreamServerUrl(this.config);
  }

  status(): ScoutBrokerChildServiceSnapshot {
    const state = this.state === "running" || this.state === "external"
      ? "running" as const
      : this.state === "starting"
        ? "starting" as const
        : this.state === "failed"
          ? "unavailable" as const
          : "stopped" as const;
    return {
      state,
      managed: this.state !== "external" && this.config.manageServer,
      managedBy: this.state === "external" ? "external" : "base",
      pid: this.child?.pid ?? null,
      port: this.config.port,
      url: this.url(),
      healthy: state === "running",
      detail: this.detail,
    };
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "external" || this.state === "starting") return;
    this.stopping = false;
    this.state = "starting";
    this.detail = null;

    const alreadyListening = await probeTcpPort(this.config.host, this.config.port);
    if (!this.config.manageServer) {
      if (!alreadyListening) {
        this.fail(`nothing is listening on ${this.url()} and management is disabled`);
        throw new Error(
          `OPENSCOUT_JETSTREAM_MANAGE_SERVER is off but nothing is listening on ${this.url()}.`,
        );
      }
      this.state = "external";
      this.detail = "attached to an externally managed NATS server";
      return;
    }
    if (alreadyListening) {
      this.fail(`port ${this.config.port} is already in use`);
      throw new JetStreamPortOccupiedError(this.url(), this.config.pidPath);
    }

    const binary = resolveNatsServerBinary(this.config.serverBinary);
    if (!binary) {
      // ENOENT is terminal, never a backoff loop: retrying a binary that does
      // not exist only hides the one message the operator needs to see.
      this.fail(`nats-server binary "${this.config.serverBinary}" not found`);
      throw new JetStreamBinaryMissingError(this.config.serverBinary);
    }

    mkdirSync(this.config.storeDirectory, { recursive: true });
    mkdirSync(dirname(this.config.logPath), { recursive: true });
    this.launch(binary);
    try {
      await this.waitUntilReady();
    } catch (error) {
      // Never leave a half-started child behind a failed status.
      await this.stop();
      this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private fail(detail: string): void {
    this.state = "failed";
    this.detail = detail;
  }

  private launch(binary: string): void {
    const logFd = openSync(this.config.logPath, "a");
    try {
      const child = this.spawnProcess(binary, [
        "--jetstream",
        "--store_dir", this.config.storeDirectory,
        "--addr", this.config.host,
        "--port", String(this.config.port),
        "--http_port", String(this.config.monitorPort),
        "--server_name", "openscout-jetstream",
        "--pid", this.config.pidPath,
      ], {
        stdio: ["ignore", logFd, logFd],
        detached: false,
        env: process.env,
      });
      this.child = child;
      this.spawnedPid = child.pid ?? null;
      child.once("exit", (code, signal) => {
        this.child = null;
        if (this.stopping) {
          this.state = "stopped";
          this.detail = null;
          return;
        }
        this.options.warn?.(
          "[openscout-jetstream] nats-server exited "
            + `(code=${code ?? "null"} signal=${signal ?? "null"})`,
        );
        this.scheduleRespawn(binary);
      });
      child.once("error", (error) => {
        this.options.error?.("[openscout-jetstream] nats-server spawn failed", error);
        this.child = null;
        this.fail(String(error));
      });
    } finally {
      // The child holds its own duplicated descriptors; the parent copy would
      // otherwise leak one fd per launch across every respawn.
      closeSync(logFd);
    }
  }

  private scheduleRespawn(binary: string): void {
    const now = this.now();
    this.recentFailures = this.recentFailures.filter((at) => now - at < RESPAWN_FAILURE_WINDOW_MS);
    this.recentFailures.push(now);
    if (this.recentFailures.length > RESPAWN_MAX_FAILURES) {
      this.fail(
        `nats-server exited ${this.recentFailures.length} times in `
          + `${Math.round(RESPAWN_FAILURE_WINDOW_MS / 1000)}s; not respawning. `
          + `See ${this.config.logPath}.`,
      );
      this.options.error?.(`[openscout-jetstream] ${this.detail}`);
      return;
    }
    const delay = Math.min(
      RESPAWN_MAX_DELAY_MS,
      RESPAWN_BASE_DELAY_MS * 2 ** (this.recentFailures.length - 1),
    );
    this.state = "starting";
    this.detail = `respawning in ${delay}ms`;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.stopping) return;
      this.launch(binary);
      void this.waitUntilReady().catch((error) => {
        this.options.error?.("[openscout-jetstream] respawn readiness failed", error);
      });
    }, delay);
    this.respawnTimer.unref?.();
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = this.now() + this.config.readyTimeoutMs;
    while (this.now() < deadline) {
      if (this.state === "failed") throw new Error(this.detail ?? "nats-server failed to start");
      if (await this.healthy()) {
        this.state = "running";
        this.detail = null;
        return;
      }
      await this.sleep(150);
    }
    throw new Error(
      `nats-server did not become ready within ${this.config.readyTimeoutMs}ms; `
        + `see ${this.config.logPath}`,
    );
  }

  /** JetStream readiness, not merely a live TCP port. */
  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(
        `${jetStreamMonitorUrl(this.config)}/healthz?js-enabled-only=true`,
        { signal: AbortSignal.timeout(1_000) },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      let killer: NodeJS.Timeout | null = setTimeout(() => {
        killer = null;
        if (child.exitCode === null) child.kill("SIGKILL");
      }, STOP_TIMEOUT_MS);
      killer.unref?.();
      await exited;
      if (killer) clearTimeout(killer);
    }
    if (this.state !== "external") {
      this.state = "stopped";
      this.detail = null;
    }
    this.cleanupPidFile();
  }

  /**
   * Remove the pid file only when it still names the child this instance
   * spawned.
   *
   * A pid file is evidence, not ownership. A failed start against an occupied
   * port, or a second supervisor pointed at the same data directory, must not
   * delete a file that belongs to a live server this object never launched.
   */
  private cleanupPidFile(): void {
    if (!this.config.manageServer || this.spawnedPid === null) return;
    try {
      if (!existsSync(this.config.pidPath)) return;
      const recorded = Number.parseInt(readFileSync(this.config.pidPath, "utf8").trim(), 10);
      if (recorded !== this.spawnedPid) return;
      rmSync(this.config.pidPath, { force: true });
    } catch {
      /* a stale pid file is not worth failing shutdown over */
    } finally {
      this.spawnedPid = null;
    }
  }
}
