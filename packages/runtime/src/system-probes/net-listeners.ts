import { defineProbeFamily, type ProbeCtx } from "./registry.js";
import { execProbeFile, ProbeCommandError } from "./exec.js";
import { runWithScoutdFallback } from "./scoutd-client.js";

export type NetListenerSnapshot = {
  port: number;
  pid: number | null;
};

function isUnavailable(error: unknown): boolean {
  return error instanceof ProbeCommandError
    && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit");
}

function lsofBin(): string {
  return process.env.OPENSCOUT_LSOF_BIN?.trim() || "lsof";
}

export const netListenersProbe = defineProbeFamily<number | string, NetListenerSnapshot>({
  id: "net.listeners",
  ttlMs: 5_000,
  timeoutMs: 1_500,
  maxKeys: 128,
  idleKeyTtlMs: 2 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: (port) => String(port).trim(),
  run: (key, ctx: ProbeCtx) => runWithScoutdFallback({
    probeId: "net.listeners",
    key,
    ctx,
    local: () => readNetListenerLocal(key, ctx),
  }),
});

async function readNetListenerLocal(key: string, ctx: ProbeCtx): Promise<NetListenerSnapshot> {
  const port = Number.parseInt(key, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return { port: 0, pid: null };
  }
  try {
    const { stdout } = await execProbeFile(ctx, lsofBin(), [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ], {
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    const match = stdout.match(/^p(\d+)/m);
    const pid = match ? Number.parseInt(match[1]!, 10) : null;
    return { port, pid: Number.isFinite(pid) ? pid : null };
  } catch (error) {
    if (isUnavailable(error)) return { port, pid: null };
    throw error;
  }
}

export async function readTcpListenerPid(port: number, maxAgeMs = 5_000): Promise<number | null> {
  const snapshot = await netListenersProbe.for(port).fresh({ maxAgeMs });
  return snapshot.value?.pid ?? null;
}
