import type { RuntimeChildProcessLike, RuntimeEnv, RuntimeReadableLike, RuntimeWritableLike } from "../portable-types.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedScoutHostProbeSchemaVersion } from "../system-probes/scout-host-catalog.js";
import { resolveScoutdProbesSocketPath } from "../system-probes/scoutd-client.js";

// Shared launcher for the native `openscout-repo-service` binary. Both the
// repo-watch scanner and the repo-diff producer drive the same binary, just a
// different subcommand, so the binary resolution and bounded-subprocess JSON
// I/O live here once.

export const REPO_SERVICE_MAX_BUFFER = 2 * 1024 * 1024;
const CAPABILITIES_SCHEMA = "openscout.probe.capabilities/v1";
const REPO_SCAN_SCHEMA = "openscout.repo.scan/v1";
const REPO_DIFF_SCHEMA = "openscout.repo.diff/v1";
const REPO_RESPONSE_SCHEMA = "openscout.repo.response/v1";
const REPO_SCAN_CAPABILITY_ID = "repo.scan";
const REPO_DIFF_CAPABILITY_ID = "repo.diff";
const CAPABILITY_RECHECK_MS = 10_000;

export type RepoServiceCommand = {
  command: string;
  args: string[];
  cwd?: string;
  subcommand: string;
};

export type RepoServiceTransportBackend = "scoutd" | "spawn" | "spawn-fallback";

export type RepoServiceTransportMetadata = {
  backend: RepoServiceTransportBackend;
  daemonVersion?: string;
  fallbackSince?: number;
  fallbackReason?: string;
};

const REPO_SERVICE_TRANSPORT_METADATA = Symbol.for("openscout.repoService.transport");

type RepoServiceChildProcess = RuntimeChildProcessLike & {
  stdin: RuntimeWritableLike;
  stdout: RuntimeReadableLike;
  stderr: RuntimeReadableLike;
};

export type RepoServiceSpawnFunction = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; stdio: ["pipe", "pipe", "pipe"] },
) => RepoServiceChildProcess;

let spawnProcess: RepoServiceSpawnFunction = spawn as unknown as RepoServiceSpawnFunction;

export function setRepoServiceSpawnForTests(spawnForTests: RepoServiceSpawnFunction | null): void {
  spawnProcess = spawnForTests ?? (spawn as unknown as RepoServiceSpawnFunction);
}

export function resetRepoServiceTransportForTests(): void {
  spawnProcess = spawn as unknown as RepoServiceSpawnFunction;
  singletonRepoServiceClient?.resetForTests();
  singletonRepoServiceClient = null;
}

export function repoServiceTransportMetadata(output: unknown): RepoServiceTransportMetadata | null {
  if (!output || typeof output !== "object") return null;
  const value = (output as { [REPO_SERVICE_TRANSPORT_METADATA]?: unknown })[REPO_SERVICE_TRANSPORT_METADATA];
  if (!value || typeof value !== "object") return null;
  const metadata = value as RepoServiceTransportMetadata;
  if (metadata.backend !== "scoutd" && metadata.backend !== "spawn" && metadata.backend !== "spawn-fallback") {
    return null;
  }
  return metadata;
}

/**
 * Resolve how to invoke `openscout-repo-service <subcommand>`. Prefers a
 * prebuilt binary via `OPENSCOUT_REPO_SERVICE_BIN`; otherwise falls back to
 * `cargo run` against the crate manifest when running inside a checkout.
 */
export function resolveRepoServiceCommand(subcommand: string): RepoServiceCommand | null {
  const explicit = process.env.OPENSCOUT_REPO_SERVICE_BIN?.trim();
  if (explicit) {
    return { command: explicit, args: [subcommand], subcommand };
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [resolve(moduleDir, "../../../.."), process.cwd()];
  const seen = new Set<string>();
  for (const root of candidateRoots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const manifestPath = resolve(root, "crates", "openscout-repo-service", "Cargo.toml");
    if (!existsSync(manifestPath)) continue;
    return {
      command: process.env.CARGO?.trim() || "cargo",
      args: ["run", "--quiet", "--manifest-path", manifestPath, "--", subcommand],
      cwd: root,
      subcommand,
    };
  }

  return null;
}

/**
 * Run a repo-service subcommand, write `input` as JSON to stdin, and parse the
 * stdout JSON response. Bounded by `timeoutMs` and an output buffer cap, with
 * SIGTERM/SIGKILL escalation on timeout.
 */
export async function runRepoServiceJson(
  command: RepoServiceCommand | null,
  input: unknown,
  timeoutMs: number,
  subcommandOverride?: string,
): Promise<unknown> {
  const subcommand = subcommandOverride ?? command?.subcommand ?? inferSubcommand(command);
  const scoutd = await getRepoServiceSocketClient().requestJob(subcommand, input, timeoutMs);
  if (scoutd.state === "scoutd") {
    return attachTransportMetadata(scoutd.value, {
      backend: "scoutd",
      daemonVersion: scoutd.daemonVersion,
    });
  }
  if (!command) {
    throw new Error(
      scoutd.fallbackReason
        ? `Repo service binary was not found after scoutd fallback: ${scoutd.fallbackReason}`
        : "Repo service binary was not found.",
    );
  }
  const output = await runRepoServiceJsonSpawn(command, input, timeoutMs);
  return attachTransportMetadata(output, scoutd.fallbackSince
    ? {
        backend: "spawn-fallback",
        fallbackSince: scoutd.fallbackSince,
        fallbackReason: scoutd.fallbackReason ?? "scoutd repo service unavailable",
      }
    : { backend: "spawn" });
}

function runRepoServiceJsonSpawn(
  command: RepoServiceCommand,
  input: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(command.command, command.args, {
      cwd: command.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const killTimer = setTimeout(() => {
      terminate();
      fail(new Error(`${command.command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    killTimer.unref?.();

    function terminate(): void {
      child.kill("SIGTERM");
      const hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      hardKillTimer.unref?.();
    }

    function cleanup(): void {
      clearTimeout(killTimer);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function succeed(output: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(output);
    }

    function append(kind: "stdout" | "stderr", chunk: unknown): void {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      if (kind === "stdout") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > REPO_SERVICE_MAX_BUFFER) {
        terminate();
        fail(new Error(`${command.command} exceeded output limit`));
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => fail(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = (stderr || `${command.command} exited with ${signal ?? code ?? "unknown status"}`).trim();
        fail(new Error(detail));
        return;
      }
      try {
        succeed(JSON.parse(stdout));
      } catch (error) {
        fail(new Error(`Repo service returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    child.stdin.end(JSON.stringify(input));
  });
}

type RepoServiceCapability = {
  probeId: string;
  schemaVersion: number;
  ttlMs: number;
};

type Capabilities = {
  daemonVersion: string;
  families: Map<string, RepoServiceCapability>;
};

type RepoServiceSocketOutcome =
  | {
      state: "scoutd";
      value: unknown;
      daemonVersion: string;
    }
  | {
      state: "spawn";
      fallbackSince?: number;
      fallbackReason?: string;
    };

type FallbackState = {
  since: number;
  reason: string;
};

class RepoServiceSocketClient {
  private capabilities: Capabilities | null = null;
  private lastCapabilityCheckAt: number | null = null;
  private lastError: string | null = null;
  private daemonObserved = false;
  private readonly fallbackByOperation = new Map<string, FallbackState>();

  constructor(private readonly env: RuntimeEnv = process.env) {}

  async requestJob(subcommand: string, input: unknown, timeoutMs: number): Promise<RepoServiceSocketOutcome> {
    const operation = operationForSubcommand(subcommand);
    if (!operation) {
      return { state: "spawn" };
    }

    const socketPath = resolveScoutdProbesSocketPath(this.env);
    const socketExists = existsSync(socketPath);
    if (!socketExists) {
      this.capabilities = null;
      this.lastError = null;
      return this.daemonObserved
        ? this.fallback(operation.capabilityId, `probe socket is missing: ${socketPath}`)
        : { state: "spawn" };
    }
    this.daemonObserved = true;

    const socketTimeoutMs = repoSocketTimeoutMs(timeoutMs);
    const capabilities = await this.ensureCapabilities(socketPath, socketTimeoutMs);
    if (!capabilities) {
      return this.fallback(operation.capabilityId, this.lastError ?? "probe capabilities unavailable");
    }
    const capability = capabilities.families.get(operation.capabilityId);
    if (!capability) {
      return this.fallback(operation.capabilityId, `scoutd does not serve ${operation.capabilityId}`);
    }
    const expectedSchemaVersion = expectedScoutHostProbeSchemaVersion(operation.capabilityId);
    if (expectedSchemaVersion === null) {
      return this.fallback(operation.capabilityId, `client has no compiled schema version for ${operation.capabilityId}`);
    }
    if (capability.schemaVersion !== expectedSchemaVersion) {
      return this.fallback(
        operation.capabilityId,
        `scoutd serves ${operation.capabilityId} schema v${capability.schemaVersion}, expected v${expectedSchemaVersion}`,
      );
    }

    let response: unknown;
    try {
      response = await requestJson(
        socketPath,
        repoRequestPayload(operation.schema, input, expectedSchemaVersion),
        socketTimeoutMs,
      );
    } catch (error) {
      this.capabilities = null;
      this.lastCapabilityCheckAt = null;
      this.lastError = fallbackMessage(error);
      return this.fallback(operation.capabilityId, this.lastError);
    }

    if (!isRecord(response) || response.schema !== REPO_RESPONSE_SCHEMA) {
      this.capabilities = null;
      this.lastCapabilityCheckAt = null;
      this.lastError = "scoutd returned an invalid repo-service envelope";
      return this.fallback(operation.capabilityId, this.lastError);
    }
    if (response.error) {
      const error = isRecord(response.error) ? response.error : {};
      const message = readString(error.message) ?? readString(error.code) ?? "scoutd repo service failed";
      throw new Error(message);
    }

    this.fallbackByOperation.delete(operation.capabilityId);
    this.lastError = null;
    return {
      state: "scoutd",
      value: response.value,
      daemonVersion: readString(response.daemonVersion) ?? capabilities.daemonVersion,
    };
  }

  resetForTests(): void {
    this.capabilities = null;
    this.lastCapabilityCheckAt = null;
    this.lastError = null;
    this.daemonObserved = false;
    this.fallbackByOperation.clear();
  }

  private async ensureCapabilities(socketPath: string, timeoutMs: number): Promise<Capabilities | null> {
    const now = Date.now();
    if (this.capabilities && this.lastCapabilityCheckAt !== null && now - this.lastCapabilityCheckAt < CAPABILITY_RECHECK_MS) {
      return this.capabilities;
    }

    this.lastCapabilityCheckAt = now;
    try {
      const response = await requestJson(socketPath, { schema: CAPABILITIES_SCHEMA }, timeoutMs);
      if (!isRecord(response) || response.schema !== CAPABILITIES_SCHEMA) {
        throw new Error("scoutd returned an invalid capabilities envelope");
      }
      const daemonVersion = readString(response.daemonVersion) ?? "unknown";
      const families = new Map<string, RepoServiceCapability>();
      if (Array.isArray(response.families)) {
        for (const entry of response.families) {
          if (!isRecord(entry)) continue;
          const probeId = readString(entry.probeId);
          const schemaVersion = readNumber(entry.schemaVersion);
          const ttlMs = readNumber(entry.ttlMs);
          if (probeId && schemaVersion !== null && ttlMs !== null) {
            families.set(probeId, { probeId, schemaVersion, ttlMs });
          }
        }
      }
      this.capabilities = { daemonVersion, families };
      this.daemonObserved = true;
      this.lastError = null;
      return this.capabilities;
    } catch (error) {
      this.capabilities = null;
      this.lastError = fallbackMessage(error);
      return null;
    }
  }

  private fallback(operation: string, reason: string): RepoServiceSocketOutcome {
    let state = this.fallbackByOperation.get(operation);
    if (!state || state.reason !== reason) {
      state = { since: Date.now(), reason };
      this.fallbackByOperation.set(operation, state);
    }
    return {
      state: "spawn",
      fallbackSince: state.since,
      fallbackReason: state.reason,
    };
  }
}

let singletonRepoServiceClient: RepoServiceSocketClient | null = null;

function getRepoServiceSocketClient(): RepoServiceSocketClient {
  singletonRepoServiceClient ??= new RepoServiceSocketClient();
  return singletonRepoServiceClient;
}

function operationForSubcommand(subcommand: string): { capabilityId: string; schema: string } | null {
  switch (subcommand) {
    case "scan":
      return { capabilityId: REPO_SCAN_CAPABILITY_ID, schema: REPO_SCAN_SCHEMA };
    case "diff":
      return { capabilityId: REPO_DIFF_CAPABILITY_ID, schema: REPO_DIFF_SCHEMA };
    default:
      return null;
  }
}

function repoRequestPayload(schema: string, input: unknown, schemaVersion: number): Record<string, unknown> {
  if (isRecord(input)) {
    return { ...input, schema, schemaVersion };
  }
  return { schema, schemaVersion, value: input };
}

function inferSubcommand(command: RepoServiceCommand | null): string {
  return command?.args.at(-1) ?? "";
}

function attachTransportMetadata(output: unknown, metadata: RepoServiceTransportMetadata): unknown {
  if (output && typeof output === "object") {
    Object.defineProperty(output, REPO_SERVICE_TRANSPORT_METADATA, {
      value: metadata,
      enumerable: false,
      configurable: true,
    });
  }
  return output;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

function repoSocketTimeoutMs(timeoutMs: number): number {
  return Math.max(900, Math.min(Math.max(0, timeoutMs) + 1_000, 31_000));
}

async function requestJson(socketPath: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  const bun = (globalThis as typeof globalThis & {
    Bun?: {
      connect?: (options: {
        unix: string;
        socket: {
          open?: (socket: { write: (data: string) => unknown; end?: () => unknown }) => void;
          data?: (socket: unknown, data: Uint8Array) => void;
          close?: () => void;
          error?: (socket: unknown, error: Error) => void;
        };
      }) => Promise<{ end?: () => unknown }>;
    };
  }).Bun;
  if (bun?.connect) {
    return await requestJsonWithBun(bun.connect, socketPath, payload, timeoutMs);
  }

  return await new Promise<unknown>((resolvePromise, reject) => {
    const socket = new Socket();
    let response = "";
    let settled = false;

    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolvePromise(value);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`scoutd repo-service socket timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const finishFromResponse = (): void => {
      if (settled) return;
      try {
        finish(null, JSON.parse(response) as unknown);
      } catch (error) {
        finish(new Error(`scoutd repo-service response was not JSON: ${fallbackMessage(error)}`));
      }
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > REPO_SERVICE_MAX_BUFFER) {
        finish(new Error("scoutd repo-service response exceeded output limit"));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", finishFromResponse);
    socket.on("close", () => {
      if (!settled) {
        if (response.length === 0) {
          finish(new Error("scoutd repo-service socket closed without a response"));
        } else {
          finishFromResponse();
        }
      }
    });
    socket.connect(socketPath);
  });
}

async function requestJsonWithBun(
  connect: NonNullable<NonNullable<(typeof globalThis & {
    Bun?: { connect?: unknown };
  })["Bun"]>["connect"]> extends (...args: infer A) => infer R ? (...args: A) => R : never,
  socketPath: string,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return await new Promise<unknown>((resolvePromise, reject) => {
    let response = "";
    let settled = false;
    let socketRef: { end?: () => unknown } | null = null;
    const decoder = new TextDecoder();

    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socketRef?.end?.();
      } catch {
        // Best-effort close only.
      }
      if (error) {
        reject(error);
      } else {
        resolvePromise(value);
      }
    };

    const finishFromResponse = (): void => {
      if (settled) return;
      try {
        finish(null, JSON.parse(response) as unknown);
      } catch (error) {
        finish(new Error(`scoutd repo-service response was not JSON: ${fallbackMessage(error)}`));
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`scoutd repo-service socket timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    void connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socketRef = socket;
          socket.write(`${JSON.stringify(payload)}\n`);
        },
        data(_socket, data) {
          response += decoder.decode(data, { stream: true });
          if (Buffer.byteLength(response, "utf8") > REPO_SERVICE_MAX_BUFFER) {
            finish(new Error("scoutd repo-service response exceeded output limit"));
          }
        },
        close() {
          if (response.length === 0) {
            finish(new Error("scoutd repo-service socket closed without a response"));
          } else {
            response += decoder.decode();
            finishFromResponse();
          }
        },
        error(_socket, error) {
          finish(error);
        },
      },
    }).then((socket) => {
      socketRef = socket;
    }, (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
