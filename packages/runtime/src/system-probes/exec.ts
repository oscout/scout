import type { RuntimeBinaryInput, RuntimeChildProcessLike, RuntimeEnv, RuntimeSignal, RuntimeSpawnFunction } from "../portable-types.js";
import { spawn } from "node:child_process";

import type { ProbeCtx } from "./registry.js";
import { getScoutdProbeClient, ScoutdExecResponseError } from "./scoutd-client.js";

export type ExecProbeFileOptions = {
  cwd?: string;
  env?: RuntimeEnv;
  input?: string | RuntimeBinaryInput;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type ExecProbeFileResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ExecSystemTransportBackend = "scoutd" | "local" | "local-fallback";

export type ExecSystemTransportMetadata = {
  backend: ExecSystemTransportBackend;
  daemonVersion?: string;
  fallbackSince?: number;
  fallbackReason?: string;
  verb?: string;
};

export class ProbeCommandError extends Error {
  code: string;
  exitCode?: number | null;
  signal?: RuntimeSignal | null;

  constructor(message: string, options: { code: string; exitCode?: number | null; signal?: RuntimeSignal | null }) {
    super(message);
    this.name = "ProbeCommandError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
  }
}

const DEFAULT_STDOUT_CAP_BYTES = 1024 * 1024;
const DEFAULT_STDERR_CAP_BYTES = 128 * 1024;
const SIGKILL_DELAY_MS = 500;
const EXEC_SYSTEM_TRANSPORT_METADATA = Symbol.for("openscout.execSystem.transport");
let spawnProcess: RuntimeSpawnFunction<RuntimeChildProcessLike> = spawn as unknown as RuntimeSpawnFunction<RuntimeChildProcessLike>;

export function setExecSystemSpawnForTests(spawnForTests: RuntimeSpawnFunction<RuntimeChildProcessLike> | null): void {
  spawnProcess = spawnForTests ?? (spawn as unknown as RuntimeSpawnFunction<RuntimeChildProcessLike>);
}

export function resetExecSystemTransportForTests(): void {
  spawnProcess = spawn as unknown as RuntimeSpawnFunction<RuntimeChildProcessLike>;
}

export function execSystemTransportMetadata(output: unknown): ExecSystemTransportMetadata | null {
  if (!output || typeof output !== "object") return null;
  const value = (output as { [EXEC_SYSTEM_TRANSPORT_METADATA]?: unknown })[EXEC_SYSTEM_TRANSPORT_METADATA];
  if (!value || typeof value !== "object") return null;
  const metadata = value as ExecSystemTransportMetadata;
  if (metadata.backend !== "scoutd" && metadata.backend !== "local" && metadata.backend !== "local-fallback") {
    return null;
  }
  return metadata;
}

function attachExecTransportMetadata<T extends ExecProbeFileResult>(
  output: T,
  metadata: ExecSystemTransportMetadata,
): T {
  Object.defineProperty(output, EXEC_SYSTEM_TRANSPORT_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
  });
  return output;
}

function bufferByteLength(chunks: Buffer[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

function abortMessage(ctx: ProbeCtx): string {
  const reason = ctx.signal.reason;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return `Probe ${ctx.probeId} aborted`;
}

export async function execProbeFile(
  ctx: ProbeCtx,
  file: string,
  args: readonly string[],
  options: ExecProbeFileOptions = {},
): Promise<ExecProbeFileResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_STDOUT_CAP_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_CAP_BYTES;

  return await new Promise<ExecProbeFileResult>((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new ProbeCommandError(abortMessage(ctx), { code: "aborted" }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawnProcess(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const cleanup = () => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      reject(error);
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, SIGKILL_DELAY_MS);
      reject(new ProbeCommandError(abortMessage(ctx), { code: "timeout" }));
    };

    ctx.signal.addEventListener("abort", onAbort, { once: true });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stdoutChunks.push(chunk);
      if (bufferByteLength(stdoutChunks) > maxStdoutBytes) {
        fail(new ProbeCommandError(
          `Probe ${ctx.probeId} stdout exceeded ${maxStdoutBytes} bytes`,
          { code: "output_cap" },
        ));
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stderrChunks.push(chunk);
      if (bufferByteLength(stderrChunks) > maxStderrBytes) {
        fail(new ProbeCommandError(
          `Probe ${ctx.probeId} stderr exceeded ${maxStderrBytes} bytes`,
          { code: "output_cap" },
        ));
      }
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const code = typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code?: unknown }).code)
        : "spawn";
      reject(new ProbeCommandError(error.message, { code }));
    });

    child.once("close", (exitCode, signal) => {
      if (settled) {
        cleanup();
        return;
      }
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      reject(new ProbeCommandError(
        `${file} exited with ${exitCode ?? signal ?? "unknown status"}`,
        { code: "exit", exitCode, signal },
      ));
    });
  });
}

export type ExecSystemFileOptions = ExecProbeFileOptions & {
  timeoutMs: number;
  probeId?: string;
};

export async function execSystemFile(
  file: string,
  args: readonly string[],
  options: ExecSystemFileOptions,
): Promise<ExecProbeFileResult> {
  const execVerb = mapExecSystemVerb(file, args, options);
  if (execVerb) {
    let scoutd;
    try {
      scoutd = await getScoutdProbeClient().requestExecVerb<ExecProbeFileResult>({
        verb: execVerb.verb,
        args: execVerb.args,
      });
    } catch (error) {
      if (error instanceof ScoutdExecResponseError) {
        throw new ProbeCommandError(error.message, { code: error.code });
      }
      throw error;
    }
    if (scoutd.state === "scoutd") {
      return attachExecTransportMetadata(normalizeExecResult(scoutd.value), {
        backend: "scoutd",
        daemonVersion: scoutd.daemonVersion,
        verb: execVerb.verb,
      });
    }
    try {
      const local = await execSystemFileLocal(file, args, options);
      return attachExecTransportMetadata(local, scoutd.fallbackSince
        ? {
            backend: "local-fallback",
            fallbackSince: scoutd.fallbackSince,
            fallbackReason: scoutd.fallbackReason ?? "scoutd exec unavailable",
            verb: execVerb.verb,
          }
        : {
            backend: "local",
            verb: execVerb.verb,
          });
    } catch (error) {
      throw error;
    }
  }

  const local = await execSystemFileLocal(file, args, options);
  return attachExecTransportMetadata(local, { backend: "local" });
}

async function execSystemFileLocal(
  file: string,
  args: readonly string[],
  options: ExecSystemFileOptions,
): Promise<ExecProbeFileResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new ProbeCommandError(
      `Command ${file} timed out after ${options.timeoutMs}ms`,
      { code: "timeout" },
    ));
  }, options.timeoutMs);
  try {
    return await execProbeFile({
      probeId: options.probeId ?? `imperative.${file}`,
      signal: controller.signal,
      timeoutMs: options.timeoutMs,
      startedAt: Date.now(),
    }, file, args, options);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeExecResult(value: ExecProbeFileResult | null | undefined): ExecProbeFileResult {
  if (!value || typeof value !== "object") {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  return {
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    exitCode: typeof value.exitCode === "number" && Number.isFinite(value.exitCode) ? value.exitCode : 0,
  };
}

type ExecVerbRequest = {
  verb: string;
  args: Record<string, unknown>;
};

function mapExecSystemVerb(
  file: string,
  args: readonly string[],
  options: ExecSystemFileOptions,
): ExecVerbRequest | null {
  const command = commandBasename(file);
  if (command === "tmux") return mapTmuxVerb(args, options);
  if (command === "tailscale") return mapTailscaleVerb(args, options);
  if (command === "open" || file === "/usr/bin/open") return mapDarwinRevealVerb(args, options);
  if (command === "xdg-open") return mapXdgRevealVerb(args, options);
  if (command === "explorer.exe") return mapWindowsRevealVerb(args, options);
  return null;
}

function commandBasename(file: string): string {
  const normalized = file.trim();
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function baseVerbArgs(options: ExecSystemFileOptions): Record<string, unknown> {
  return { timeoutMs: options.timeoutMs };
}

function mapTmuxVerb(rawArgs: readonly string[], options: ExecSystemFileOptions): ExecVerbRequest | null {
  const { socketPath, args } = stripTmuxSocketArgs(rawArgs);
  const command = args[0];
  const base = { ...baseVerbArgs(options), ...(socketPath ? { socketPath } : {}) };
  if (command === "send-keys") {
    const parsed = parseTmuxSendKeys(args.slice(1));
    if (!parsed) return null;
    if (parsed.literal !== null) {
      return {
        verb: "tmux.sendKeysLiteral",
        args: { ...base, target: parsed.target, text: parsed.literal },
      };
    }
    return {
      verb: "tmux.sendKeys",
      args: { ...base, target: parsed.target, keys: parsed.keys },
    };
  }
  if (command === "load-buffer") {
    const bufferName = optionValue(args.slice(1), "-b");
    if (!bufferName || args[args.length - 1] !== "-" || options.input === undefined) return null;
    return {
      verb: "tmux.loadBuffer",
      args: {
        ...base,
        bufferName,
        content: typeof options.input === "string" ? options.input : Buffer.from(options.input as any).toString("utf8"),
      },
    };
  }
  if (command === "paste-buffer") {
    const flags = args[1];
    const bufferName = optionValue(args.slice(1), "-b");
    const target = optionValue(args.slice(1), "-t");
    if (!flags || !bufferName || !target) return null;
    return {
      verb: "tmux.pasteBuffer",
      args: { ...base, flags, bufferName, target },
    };
  }
  if (command === "delete-buffer") {
    const bufferName = optionValue(args.slice(1), "-b");
    if (!bufferName) return null;
    return { verb: "tmux.deleteBuffer", args: { ...base, bufferName } };
  }
  if (command === "kill-session") {
    const target = optionValue(args.slice(1), "-t");
    if (!target) return null;
    return { verb: "tmux.killSession", args: { ...base, target } };
  }
  if (command === "detach-client") {
    const sessionName = optionValue(args.slice(1), "-s");
    if (!sessionName) return null;
    return { verb: "tmux.detachClient", args: { ...base, sessionName } };
  }
  if (command === "new-session") {
    const parsed = parseTmuxNewSession(args.slice(1));
    if (!parsed) return null;
    return { verb: "tmux.newSession", args: { ...base, ...parsed } };
  }
  return null;
}

function stripTmuxSocketArgs(rawArgs: readonly string[]): { socketPath: string | null; args: string[] } {
  if (rawArgs[0] === "-S" && typeof rawArgs[1] === "string" && rawArgs[1].trim()) {
    return { socketPath: rawArgs[1], args: [...rawArgs.slice(2)] };
  }
  return { socketPath: null, args: [...rawArgs] };
}

function parseTmuxSendKeys(args: readonly string[]): { target: string; keys: string[]; literal: string | null } | null {
  const target = optionValue(args, "-t");
  if (!target) return null;
  const keys: string[] = [];
  let literal: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-t") {
      index += 1;
      continue;
    }
    if (arg === "-l") {
      literal = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    keys.push(arg);
  }
  const optionLikeKey = keys.find((key) => key.startsWith("-"));
  if (optionLikeKey) {
    throw new ProbeCommandError(`tmux key must not start with '-': ${optionLikeKey}`, { code: "invalid_request" });
  }
  if (literal !== null) return literal ? { target, keys: [], literal } : null;
  return keys.length > 0 ? { target, keys, literal: null } : null;
}

function parseTmuxNewSession(args: readonly string[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = { detached: false, printPane: false };
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-d") {
      out.detached = true;
      index += 1;
      continue;
    }
    if (arg === "-P") {
      out.printPane = true;
      index += 1;
      continue;
    }
    if (arg === "-dP" || arg === "-Pd") {
      out.detached = true;
      out.printPane = true;
      index += 1;
      continue;
    }
    if (arg === "-s" || arg === "-n" || arg === "-c" || arg === "-F" || arg === "-x" || arg === "-y") {
      const value = args[index + 1];
      if (!value) return null;
      if (arg === "-s") out.sessionName = value;
      if (arg === "-n") out.windowName = value;
      if (arg === "-c") out.cwd = value;
      if (arg === "-F") out.format = value;
      if (arg === "-x" || arg === "-y") {
        const parsed = positiveInteger(value);
        if (parsed === null) return null;
        if (arg === "-x") out.columns = parsed;
        if (arg === "-y") out.rows = parsed;
      }
      index += 2;
      continue;
    }
    out.command = args.slice(index).join(" ");
    break;
  }
  if (typeof out.sessionName !== "string" || typeof out.command !== "string" || !out.command.trim()) {
    return null;
  }
  return out;
}

function positiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function optionValue(args: readonly string[], option: string): string | null {
  const index = args.indexOf(option);
  const value = index >= 0 ? args[index + 1] : null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapTailscaleVerb(args: readonly string[], options: ExecSystemFileOptions): ExecVerbRequest | null {
  if (args[0] !== "cert") return null;
  const certFile = optionValue(args.slice(1), "--cert-file");
  const keyFile = optionValue(args.slice(1), "--key-file");
  const hostname = args[args.length - 1];
  if (!certFile || !keyFile || !hostname || hostname.startsWith("-")) return null;
  return {
    verb: "tailscale.cert",
    args: { ...baseVerbArgs(options), certFile, keyFile, hostname },
  };
}

function mapDarwinRevealVerb(args: readonly string[], options: ExecSystemFileOptions): ExecVerbRequest | null {
  if (args.length === 2 && args[0] === "-R" && args[1]) {
    return {
      verb: "reveal.open",
      args: { ...baseVerbArgs(options), mode: "darwinReveal", targetPath: args[1] },
    };
  }
  if (args.length === 1 && args[0]) {
    return {
      verb: "reveal.open",
      args: { ...baseVerbArgs(options), mode: "darwinOpen", targetPath: args[0] },
    };
  }
  return null;
}

function mapXdgRevealVerb(args: readonly string[], options: ExecSystemFileOptions): ExecVerbRequest | null {
  if (args.length !== 1 || !args[0]) return null;
  return {
    verb: "reveal.open",
    args: { ...baseVerbArgs(options), mode: "xdgOpen", targetPath: args[0] },
  };
}

function mapWindowsRevealVerb(args: readonly string[], options: ExecSystemFileOptions): ExecVerbRequest | null {
  if (args.length !== 1 || !args[0]?.startsWith("/select,")) return null;
  return {
    verb: "reveal.open",
    args: { ...baseVerbArgs(options), mode: "windowsSelect", targetPath: args[0].slice("/select,".length) },
  };
}
