import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readProcessField,
  readTcpListenerPid,
  execSystemFile,
} from "@openscout/runtime/system-probes";

const TERMINAL_RELAY_HEALTH_SURFACE = "openscout-terminal-relay";
const AUTO_RELAY_PORT_ATTEMPTS = 16;

export type TerminalRelayHealth = {
  ok: true;
  surface: typeof TERMINAL_RELAY_HEALTH_SURFACE;
  pid?: number;
  sessions?: number;
  attachedSessions?: number;
};

export type ManagedTerminalRelay = {
  healthcheck: () => Promise<boolean>;
  readHealth: () => Promise<TerminalRelayHealth | null>;
  queueCommand: (request: TerminalRelayRunRequest) => Promise<void>;
  destroySession: (sessionId: string) => Promise<boolean>;
  destroySurface: (backend: "tmux" | "zellij" | "herdr", sessionName: string) => Promise<number>;
  shutdown: () => void;
  targetHttpUrl: string;
  targetWebSocketUrl: string;
};

export type TerminalRelayRunRequest = {
  command: string;
  cwd?: string | null;
  agentId?: string | null;
};

function relayPortPreferenceForWebPort(webPort: number): { port: number; configured: boolean } {
  const configured = process.env.OPENSCOUT_WEB_TERMINAL_RELAY_PORT?.trim();
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { port: parsed, configured: true };
    }
  }
  return { port: webPort + 1, configured: false };
}

function relayHostForWebHost(hostname: string): string {
  const override = process.env.OPENSCOUT_WEB_TERMINAL_RELAY_HOST?.trim();
  if (override) {
    return override;
  }
  // The terminal relay spawns login-shell PTYs and is only ever consumed by the
  // co-located web server, which connects over loopback (see relayLoopbackHost).
  // Never inherit the web server's LAN bind (0.0.0.0) — doing so would expose an
  // unauthenticated PTY-spawning WebSocket to the network. Force loopback.
  return relayLoopbackHost(hostname);
}

function relayLoopbackHost(hostname: string): string {
  if (hostname === "0.0.0.0" || hostname === "::") {
    return "127.0.0.1";
  }
  return hostname;
}

function isTerminalRelayHealthPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as { ok?: unknown; surface?: unknown };
  return body.ok === true && body.surface === TERMINAL_RELAY_HEALTH_SURFACE;
}

export async function readTerminalRelayHealth(targetHttpUrl: string): Promise<TerminalRelayHealth | null> {
  try {
    const response = await fetch(`${targetHttpUrl}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json().catch(() => null);
    if (!isTerminalRelayHealthPayload(payload)) {
      return null;
    }
    const body = payload as TerminalRelayHealth;
    return {
      ok: true,
      surface: TERMINAL_RELAY_HEALTH_SURFACE,
      ...(Number.isFinite(body.pid) ? { pid: body.pid } : {}),
      ...(Number.isFinite(body.sessions) ? { sessions: body.sessions } : {}),
      ...(Number.isFinite(body.attachedSessions) ? { attachedSessions: body.attachedSessions } : {}),
    };
  } catch {
    return null;
  }
}

export async function isTerminalRelayHealthy(targetHttpUrl: string): Promise<boolean> {
  return (await readTerminalRelayHealth(targetHttpUrl)) !== null;
}

async function waitForHealthy(
  targetHttpUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTerminalRelayHealthy(targetHttpUrl)) {
      return true;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
  return false;
}

async function canListenOnPort(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolveListen) => {
    const server = createTcpServer();
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveListen(available);
    };

    server.once("error", () => finish(false));
    server.once("listening", () => {
      server.close(() => finish(true));
    });
    server.listen(port, hostname);
  });
}

async function waitForPortAvailable(hostname: string, port: number, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canListenOnPort(hostname, port)) {
      return true;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  }
  return false;
}

async function resolveRuntimeEntry(): Promise<string> {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const sourceEntry = resolve(selfDir, "terminal-relay-node.ts");
  const bundledEntry = resolve(selfDir, "openscout-terminal-relay.mjs");
  const sourceBundle = resolve(selfDir, "../dist/openscout-terminal-relay.mjs");

  if (existsSync(sourceEntry)) {
    await execSystemFile(
      "bun",
      [
        "build",
        sourceEntry,
        "--target=node",
        "--format=esm",
        "--outfile",
        sourceBundle,
        "--external",
        "@lydell/node-pty",
      ],
      {
        cwd: resolve(selfDir, ".."),
        timeoutMs: 30_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 2 * 1024 * 1024,
      },
    );
    return sourceBundle;
  }

  if (existsSync(bundledEntry)) {
    return bundledEntry;
  }

  throw new Error("Could not locate the terminal relay runtime entry");
}

function relayPortRange(preferredPort: number): number[] {
  return Array.from({ length: AUTO_RELAY_PORT_ATTEMPTS }, (_, offset) => preferredPort + offset);
}

async function tcpListenerPid(port: number): Promise<number | null> {
  return await readTcpListenerPid(port);
}

async function processField(pid: number, field: "command" | "ppid"): Promise<string | null> {
  return await readProcessField(pid, field);
}

async function processParentPid(pid: number): Promise<number | null> {
  const raw = await processField(pid, "ppid");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRelayCommandIdentity(command: string): boolean {
  const relayNames = new Set([
    "scout-relay",
    "openscout-terminal-relay",
    "openscout-terminal-relay.mjs",
    "terminal-relay-node",
    "terminal-relay-node.ts",
  ]);
  return command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .some((token) => relayNames.has(basename(token)));
}

async function isRelayProcess(pid: number): Promise<boolean> {
  const command = await processField(pid, "command") ?? "";
  return isRelayCommandIdentity(command);
}

export function isLegacyOrphanTerminalRelay(input: {
  health: TerminalRelayHealth;
  listenerPid: number | null;
  parentPid: number | null;
  command: string;
}): boolean {
  return Boolean(
    input.listenerPid
    && input.health.pid === input.listenerPid
    && input.parentPid === 1
    && isRelayCommandIdentity(input.command)
    && input.health.sessions === 0
    && input.health.attachedSessions === 0
  );
}

async function terminateIdleLegacyOrphanRelay(
  health: TerminalRelayHealth,
  listenerPid: number | null,
): Promise<boolean> {
  if (!listenerPid || listenerPid === process.pid) return false;
  const [parentPid, command] = await Promise.all([
    processParentPid(listenerPid),
    processField(listenerPid, "command").then((value) => value ?? ""),
  ]);
  if (!isLegacyOrphanTerminalRelay({ health, listenerPid, parentPid, command })) {
    return false;
  }
  console.warn(`[relay] Replacing idle pre-watchdog orphan relay pid ${listenerPid}`);
  return terminateRelayPid(listenerPid);
}

async function relayPidOwnedByThisWebProcess(pid: number | null): Promise<boolean> {
  return Boolean(pid && pid !== process.pid && await processParentPid(pid) === process.pid && await isRelayProcess(pid));
}

function terminateRelayPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function terminateOwnedRelayListener(port: number, keepPid: number | null): Promise<boolean> {
  const pid = await tcpListenerPid(port);
  if (!await relayPidOwnedByThisWebProcess(pid) || pid === keepPid) {
    return false;
  }
  return terminateRelayPid(pid);
}

async function cleanupOwnedRelayListeners(ports: number[], keepPort: number): Promise<void> {
  const keepPid = await tcpListenerPid(keepPort);
  for (const port of ports) {
    if (port === keepPort) continue;
    await terminateOwnedRelayListener(port, keepPid);
  }
}

export async function startManagedTerminalRelay(args: {
  hostname: string;
  webPort: number;
}): Promise<ManagedTerminalRelay> {
  const relayPortPreference = relayPortPreferenceForWebPort(args.webPort);
  const bindHost = relayHostForWebHost(args.hostname);
  const loopbackHost = relayLoopbackHost(bindHost);
  const ports = relayPortRange(relayPortPreference.port);
  const preferredTargetHttpUrl = `http://${loopbackHost}:${relayPortPreference.port}`;
  const preferredTargetWebSocketUrl = `ws://${loopbackHost}:${relayPortPreference.port}`;
  let preferredHealth = await readTerminalRelayHealth(preferredTargetHttpUrl);

  if (preferredHealth) {
    const listenerPid = await tcpListenerPid(relayPortPreference.port);
    if (await terminateIdleLegacyOrphanRelay(preferredHealth, listenerPid)) {
      if (!await waitForPortAvailable(bindHost, relayPortPreference.port)) {
        throw new Error(
          `Idle legacy terminal relay on port ${relayPortPreference.port} did not exit`,
        );
      }
      preferredHealth = null;
    }
  }

  if (preferredHealth) {
    await cleanupOwnedRelayListeners(ports, relayPortPreference.port);
    const listenerPid = preferredHealth.pid ?? await tcpListenerPid(relayPortPreference.port);
    return createManagedRelayHandle({
      targetHttpUrl: preferredTargetHttpUrl,
      targetWebSocketUrl: preferredTargetWebSocketUrl,
      ownedPid: await relayPidOwnedByThisWebProcess(listenerPid) ? listenerPid : null,
    });
  }

  let preferredPortAvailable = await canListenOnPort(bindHost, relayPortPreference.port);
  if (!preferredPortAvailable && await terminateOwnedRelayListener(relayPortPreference.port, null)) {
    preferredPortAvailable = await waitForPortAvailable(bindHost, relayPortPreference.port);
  }

  if (!relayPortPreference.configured && !preferredPortAvailable) {
    for (const relayPort of ports.slice(1)) {
      const targetHttpUrl = `http://${loopbackHost}:${relayPort}`;
      const targetWebSocketUrl = `ws://${loopbackHost}:${relayPort}`;
      const health = await readTerminalRelayHealth(targetHttpUrl);
      if (!health) continue;
      console.warn(
        `[relay] Reusing existing terminal relay on port ${relayPort}; preferred port ${relayPortPreference.port} is occupied`,
      );
      await cleanupOwnedRelayListeners(ports, relayPort);
      const listenerPid = health.pid ?? await tcpListenerPid(relayPort);
      return createManagedRelayHandle({
        targetHttpUrl,
        targetWebSocketUrl,
        ownedPid: await relayPidOwnedByThisWebProcess(listenerPid) ? listenerPid : null,
      });
    }
  }

  const runtimeEntry = await resolveRuntimeEntry();

  for (let offset = 0; offset < ports.length; offset += 1) {
    const relayPort = ports[offset]!;
    const targetHttpUrl = `http://${loopbackHost}:${relayPort}`;
    const targetWebSocketUrl = `ws://${loopbackHost}:${relayPort}`;
    let portAvailable = relayPort === relayPortPreference.port
      ? preferredPortAvailable
      : await canListenOnPort(bindHost, relayPort);

    if (!portAvailable) {
      if (await terminateOwnedRelayListener(relayPort, null)) {
        portAvailable = await waitForPortAvailable(bindHost, relayPort);
      }
    }

    if (!portAvailable) {
      if (relayPortPreference.configured) {
        throw new Error(
          `Configured terminal relay port ${relayPort} is already in use and is not an OpenScout terminal relay`,
        );
      }
      if (offset === 0) {
        console.warn(
          `[relay] Terminal relay port ${relayPort} is occupied by another service; trying the next available port`,
        );
      }
      continue;
    }

    const relay = await startRelayProcess({
      runtimeEntry,
      bindHost,
      relayPort,
      targetHttpUrl,
      targetWebSocketUrl,
    });
    await cleanupOwnedRelayListeners(ports, relayPort);
    return relay;
  }

  throw new Error(
    `Could not find an available terminal relay port starting at ${relayPortPreference.port}`,
  );
}

function createManagedRelayHandle(input: {
  targetHttpUrl: string;
  targetWebSocketUrl: string;
  child?: ChildProcess;
  ownedPid?: number | null;
}): ManagedTerminalRelay {
  return {
    healthcheck: () => isTerminalRelayHealthy(input.targetHttpUrl),
    readHealth: () => readTerminalRelayHealth(input.targetHttpUrl),
    queueCommand: async (request: TerminalRelayRunRequest) => {
      const response = await fetch(`${input.targetHttpUrl}/api/terminal/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error("Terminal relay rejected queued command");
      }
    },
    destroySession: async (sessionId: string) => {
      const response = await fetch(`${input.targetHttpUrl}/api/terminal/session/destroy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!response.ok) {
        throw new Error("Terminal relay rejected session destroy");
      }
      const body = await response.json().catch(() => null) as { destroyed?: unknown } | null;
      return body?.destroyed === true;
    },
    destroySurface: async (backend: "tmux" | "zellij" | "herdr", sessionName: string) => {
      const response = await fetch(`${input.targetHttpUrl}/api/terminal/session/destroy-surface`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, sessionName }),
      });
      if (!response.ok) {
        throw new Error("Terminal relay rejected surface destroy");
      }
      const body = await response.json().catch(() => null) as { destroyed?: unknown } | null;
      return typeof body?.destroyed === "number" ? body.destroyed : 0;
    },
    shutdown() {
      if (input.child) {
        terminateChild(input.child);
        return;
      }
      if (input.ownedPid) {
        terminateRelayPid(input.ownedPid);
      }
    },
    targetHttpUrl: input.targetHttpUrl,
    targetWebSocketUrl: input.targetWebSocketUrl,
  };
}

async function startRelayProcess(input: {
  runtimeEntry: string;
  bindHost: string;
  relayPort: number;
  targetHttpUrl: string;
  targetWebSocketUrl: string;
}): Promise<ManagedTerminalRelay> {
  const child = spawn(
    "node",
    [input.runtimeEntry],
    {
      argv0: "scout-relay",
      cwd: resolve(dirname(input.runtimeEntry), ".."),
      env: {
        ...process.env,
        OPENSCOUT_WEB_TERMINAL_RELAY_HOST: input.bindHost,
        OPENSCOUT_WEB_TERMINAL_RELAY_PORT: String(input.relayPort),
        OPENSCOUT_WEB_RELAY_PARENT_PID: String(process.pid),
      },
      stdio: "inherit",
    },
  );

  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") {
      return;
    }
    console.error(
      `[relay] Managed terminal relay exited unexpectedly (code: ${code ?? "null"}, signal: ${signal ?? "none"})`,
    );
  });

  const ready = await waitForHealthy(input.targetHttpUrl, 5000);
  if (ready) {
    return createManagedRelayHandle({
      targetHttpUrl: input.targetHttpUrl,
      targetWebSocketUrl: input.targetWebSocketUrl,
      child,
    });
  }

  if (!child.killed) {
    child.kill("SIGTERM");
  }
  if (spawnError) {
    throw spawnError;
  }
  throw new Error(`Terminal relay did not become healthy at ${input.targetHttpUrl}`);
}

function terminateChild(child: ChildProcess) {
  if (child.killed) {
    return;
  }
  child.kill("SIGTERM");
}
