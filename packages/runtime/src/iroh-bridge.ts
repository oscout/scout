import type { RuntimeChildProcessLike, RuntimeEnv, RuntimeReadableLike } from "./portable-types.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import type { IrohMeshEntrypoint } from "@openscout/protocol";
import {
  OPENSCOUT_IROH_MESH_ALPN,
  OPENSCOUT_MESH_PROTOCOL_VERSION,
} from "@openscout/protocol";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export type IrohBridgeMeshRoute =
  | "messages"
  | "invocations"
  | "collaboration/records"
  | "collaboration/events";

export interface IrohBridgeForwardOptions {
  timeoutMs?: number;
  bridgeBin?: string;
  identityPath?: string;
}

export interface IrohBridgeServeOptions {
  brokerUrl: string;
  onlineTimeoutMs?: number;
  startupTimeoutMs?: number;
  bridgeBin?: string;
  identityPath?: string;
}

export interface IrohBridgeResponse<TBody = unknown> {
  status: number;
  body: TBody;
}

export interface IrohBridgeService {
  child: RuntimeChildProcessLike;
  entrypoint: IrohMeshEntrypoint;
  identityPath: string;
  stop: () => void;
}

interface IrohBridgeServeOutput {
  bridgeProtocolVersion: number;
  alpn: string;
  endpointId: string;
  endpointAddr: unknown;
  identityPath: string;
}

export function resolveIrohBridgeBin(): string | null {
  const explicit = process.env.OPENSCOUT_IROH_BRIDGE_BIN?.trim();
  return explicit || null;
}

export function resolveIrohBridgeIdentityPath(): string {
  const explicit = process.env.OPENSCOUT_IROH_IDENTITY_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "mesh", "iroh.key");
}

export function canUseIrohBridge(options: IrohBridgeForwardOptions = {}): boolean {
  return Boolean(options.bridgeBin?.trim() || resolveIrohBridgeBin());
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readEndpointId(endpointAddr: unknown): string | undefined {
  if (!endpointAddr || typeof endpointAddr !== "object" || Array.isArray(endpointAddr)) {
    return undefined;
  }
  const value = (endpointAddr as { id?: unknown }).id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveIrohMeshEntrypointFromEnv(env: RuntimeEnv = process.env): IrohMeshEntrypoint | undefined {
  const rawEndpointAddr = env.OPENSCOUT_IROH_ENDPOINT_ADDR_JSON?.trim();
  if (!rawEndpointAddr) {
    return undefined;
  }

  let endpointAddr: unknown;
  try {
    endpointAddr = JSON.parse(rawEndpointAddr);
  } catch (error) {
    throw new Error("OPENSCOUT_IROH_ENDPOINT_ADDR_JSON must be valid JSON", { cause: error });
  }

  const endpointId = env.OPENSCOUT_IROH_ENDPOINT_ID?.trim() || readEndpointId(endpointAddr);
  if (!endpointId) {
    throw new Error("OPENSCOUT_IROH_ENDPOINT_ID is required when endpointAddr JSON does not include an id");
  }

  return {
    kind: "iroh",
    endpointId,
    endpointAddr,
    alpn: OPENSCOUT_IROH_MESH_ALPN,
    bridgeProtocolVersion: OPENSCOUT_MESH_PROTOCOL_VERSION,
    lastSeenAt: Date.now(),
  };
}

function entrypointFromServeOutput(output: IrohBridgeServeOutput): IrohMeshEntrypoint {
  if (output.alpn !== OPENSCOUT_IROH_MESH_ALPN) {
    throw new Error(`Iroh bridge reported unsupported ALPN ${output.alpn}`);
  }
  if (output.bridgeProtocolVersion !== OPENSCOUT_MESH_PROTOCOL_VERSION) {
    throw new Error(`Iroh bridge reported unsupported protocol version ${output.bridgeProtocolVersion}`);
  }
  if (!output.endpointId?.trim()) {
    throw new Error("Iroh bridge did not report an endpoint id");
  }
  return {
    kind: "iroh",
    endpointId: output.endpointId,
    endpointAddr: output.endpointAddr,
    alpn: OPENSCOUT_IROH_MESH_ALPN,
    bridgeProtocolVersion: OPENSCOUT_MESH_PROTOCOL_VERSION,
    lastSeenAt: Date.now(),
  };
}

function parseServeOutputLine(line: string): IrohBridgeServeOutput | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  return JSON.parse(trimmed) as IrohBridgeServeOutput;
}

export async function startIrohBridgeServe(options: IrohBridgeServeOptions): Promise<IrohBridgeService> {
  const bridgeBin = options.bridgeBin?.trim() || resolveIrohBridgeBin();
  if (!bridgeBin) {
    throw new Error("OPENSCOUT_IROH_BRIDGE_BIN is not configured");
  }

  const identityPath = options.identityPath?.trim() || resolveIrohBridgeIdentityPath();
  const onlineTimeoutMs = options.onlineTimeoutMs ?? 5_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? Math.max(onlineTimeoutMs + 2_000, 5_000);
  const child = spawn(bridgeBin, [
    "serve",
    "--identity-path",
    identityPath,
    "--broker-url",
    options.brokerUrl,
    "--online-timeout-ms",
    String(onlineTimeoutMs),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.end();

  return await new Promise<IrohBridgeService>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Iroh bridge did not report endpoint metadata within ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    function settleReject(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }

    child.once("error", (error) => {
      settleReject(error);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = stderrBuffer.trim() || `exit ${code ?? signal ?? "unknown"}`;
      settleReject(new Error(`Iroh bridge exited before reporting endpoint metadata: ${detail}`));
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");
        if (!line.trim()) continue;

        try {
          const output = parseServeOutputLine(line);
          if (!output) continue;
          const entrypoint = entrypointFromServeOutput(output);
          settled = true;
          clearTimeout(timer);
          resolve({
            child,
            entrypoint,
            identityPath,
            stop: () => {
              if (!child.killed) {
                child.kill("SIGTERM");
              }
            },
          });
          return;
        } catch (error) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
  });
}

export async function startIrohBridgeServeFromEnv(input: {
  brokerUrl: string;
  env?: RuntimeEnv;
}): Promise<IrohBridgeService | undefined> {
  const env = input.env ?? process.env;
  if (env.OPENSCOUT_IROH_BRIDGE_AUTO_START?.trim().toLowerCase() === "false") {
    return undefined;
  }

  const bridgeBin = env.OPENSCOUT_IROH_BRIDGE_BIN?.trim();
  if (!bridgeBin) {
    return undefined;
  }

  return startIrohBridgeServe({
    brokerUrl: input.brokerUrl,
    bridgeBin,
    identityPath: env.OPENSCOUT_IROH_IDENTITY_PATH,
    onlineTimeoutMs: readPositiveInteger(env.OPENSCOUT_IROH_ONLINE_TIMEOUT_MS, 5_000),
    startupTimeoutMs: readPositiveInteger(env.OPENSCOUT_IROH_STARTUP_TIMEOUT_MS, 7_000),
  });
}

function readChildOutput(stream: RuntimeReadableLike, onChunk?: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      onChunk?.(buffer.toString("utf8"));
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function forwardIrohMeshEnvelope<TResponse>(
  entrypoint: IrohMeshEntrypoint,
  route: IrohBridgeMeshRoute,
  payload: unknown,
  options: IrohBridgeForwardOptions = {},
): Promise<IrohBridgeResponse<TResponse>> {
  const bridgeBin = options.bridgeBin?.trim() || resolveIrohBridgeBin();
  if (!bridgeBin) {
    throw new Error("OPENSCOUT_IROH_BRIDGE_BIN is not configured");
  }

  const identityPath = options.identityPath?.trim() || resolveIrohBridgeIdentityPath();
  const args = [
    "forward",
    "--identity-path",
    identityPath,
    "--endpoint-addr-json",
    JSON.stringify(entrypoint.endpointAddr),
    "--route",
    route,
    "--timeout-ms",
    String(options.timeoutMs ?? 5_000),
  ];

  const child = spawn(bridgeBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, options.timeoutMs ?? 5_000);

  const stderrChunks: string[] = [];
  const stdoutPromise = readChildOutput(child.stdout);
  const stderrPromise = readChildOutput(child.stderr, (chunk) => {
    stderrChunks.push(chunk);
  });

  child.stdin.end(JSON.stringify(payload));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  }).finally(() => {
    clearTimeout(timeout);
  });

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Iroh bridge exited with ${exitCode}`);
  }

  try {
    return JSON.parse(stdout) as IrohBridgeResponse<TResponse>;
  } catch (error) {
    const detail = stderrChunks.join("").trim();
    throw new Error(`Iroh bridge returned invalid JSON${detail ? `: ${detail}` : ""}`, { cause: error });
  }
}
