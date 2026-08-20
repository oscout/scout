import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Subprocess } from "bun";

type RuntimeKind = "bun" | "node";

type ProcessEnv = Record<string, string | undefined>;

export interface HarnessProcess {
  readonly runtime: RuntimeKind;
  readonly pid: number | undefined;
  readonly killed: boolean;
  readonly stdin: {
    readonly writable: boolean;
    write(chunk: string): void;
  };
  kill(signal?: number | NodeJS.Signals): void;
  onError(handler: (error: Error) => void): void;
  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  readStdoutLines(onLine: (line: string) => void, onEnd?: () => void): void;
  readStderrLines(onLine: (line: string) => void, onEnd?: () => void): void;
  drainStdout(): void;
  drainStderr(): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface HarnessSpawnOptions {
  cwd?: string;
  env?: ProcessEnv;
  stdin?: "pipe" | "ignore";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
}

export async function spawnHarnessProcess(
  command: string,
  args: readonly string[],
  options: HarnessSpawnOptions,
): Promise<HarnessProcess> {
  if (typeof Bun !== "undefined") {
    return wrapBunProcess(Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin ?? "pipe",
      stdout: options.stdout ?? "pipe",
      stderr: options.stderr ?? "pipe",
    }));
  }

  const { spawn } = await import("node:child_process");
  return wrapNodeProcess(spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [
      options.stdin ?? "pipe",
      options.stdout ?? "pipe",
      options.stderr ?? "pipe",
    ],
  }) as ChildProcessWithoutNullStreams);
}

function wrapBunProcess(child: Subprocess<"pipe", "pipe", "pipe">): HarnessProcess {
  return {
    runtime: "bun",
    get pid() {
      return child.pid;
    },
    get killed() {
      return child.killed;
    },
    stdin: {
      get writable() {
        return child.exitCode === null && child.stdin !== null && typeof child.stdin !== "number";
      },
      write(chunk: string) {
        if (child.stdin === null || typeof child.stdin === "number") return;
        child.stdin.write(chunk);
        child.stdin.flush();
      },
    },
    kill(signal?: number | NodeJS.Signals) {
      child.kill(signal);
    },
    onError() {
      // Bun.spawn throws synchronously for launch failures; subprocesses expose
      // exit state through `exited` rather than an EventEmitter error event.
    },
    onExit(handler) {
      child.exited.then(
        (code) => handler(code, child.signalCode),
        () => handler(child.exitCode, child.signalCode),
      );
    },
    readStdoutLines(onLine, onEnd) {
      readWebStreamLines(child.stdout, onLine, onEnd);
    },
    readStderrLines(onLine, onEnd) {
      readWebStreamLines(child.stderr, onLine, onEnd);
    },
    drainStdout() {
      drainWebStream(child.stdout);
    },
    drainStderr() {
      drainWebStream(child.stderr);
    },
    async waitForExit(timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return true;
      }
      return await Promise.race([
        child.exited.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    },
  };
}

function wrapNodeProcess(child: ChildProcessWithoutNullStreams): HarnessProcess {
  return {
    runtime: "node",
    get pid() {
      return child.pid;
    },
    get killed() {
      return child.killed;
    },
    stdin: {
      get writable() {
        return child.stdin.writable;
      },
      write(chunk: string) {
        child.stdin.write(chunk);
      },
    },
    kill(signal?: number | NodeJS.Signals) {
      child.kill(signal);
    },
    onError(handler) {
      child.once("error", handler);
    },
    onExit(handler) {
      if (child.exitCode !== null || child.signalCode !== null) {
        queueMicrotask(() => handler(child.exitCode, child.signalCode));
        return;
      }
      child.once("exit", handler);
    },
    readStdoutLines(onLine, onEnd) {
      readNodeStreamLines(child.stdout, onLine, onEnd);
    },
    readStderrLines(onLine, onEnd) {
      readNodeStreamLines(child.stderr, onLine, onEnd);
    },
    drainStdout() {
      child.stdout.resume();
    },
    drainStderr() {
      child.stderr.resume();
    },
    async waitForExit(timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return true;
      }
      return await Promise.race([
        new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    },
  };
}

function readNodeStreamLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onEnd?: () => void,
): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer = consumeLines(buffer + chunk, onLine);
  });
  stream.once("end", () => {
    flushLine(buffer, onLine);
    onEnd?.();
  });
}

function readWebStreamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onEnd?: () => void,
): void {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = consumeLines(buffer + decoder.decode(value, { stream: true }), onLine);
      }
      buffer += decoder.decode();
    } catch {
      // Treat stream closure as process shutdown; callers handle exit state.
    } finally {
      flushLine(buffer, onLine);
      onEnd?.();
    }
  })();
}

function drainWebStream(stream: ReadableStream<Uint8Array>): void {
  const reader = stream.getReader();
  void (async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Ignore stream closure while draining process output.
    }
  })();
}

function consumeLines(buffer: string, onLine: (line: string) => void): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    onLine(line);
  }
  return remainder;
}

function flushLine(line: string, onLine: (line: string) => void): void {
  if (line.length > 0) {
    onLine(line);
  }
}
