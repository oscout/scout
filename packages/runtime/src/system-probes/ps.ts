import { defineProbe, defineProbeFamily, type ProbeCtx } from "./registry.js";
import { execProbeFile, ProbeCommandError } from "./exec.js";
import { runWithScoutdFallback } from "./scoutd-client.js";

const PS_TTL_MS = 5_000;
const PS_TIMEOUT_MS = 1_500;
const DEFAULT_PS_DISCOVERY_MAX_ROWS = 4_096;
const PS_DISCOVERY_MAX_COMMAND_CHARS = 1_024;

export type ProcessRow = {
  pid: number;
  ppid: number;
  pgid: number;
  comm: string;
  tty: string | null;
};

export type ProcessCommandRow = ProcessRow & {
  command: string;
};

export type ProcessDiscoveryRow = {
  pid: number;
  ppid: number;
  etime: string;
  command: string;
};

export type ProcessDiscoverySnapshot = {
  rows: ProcessDiscoveryRow[];
  truncated: boolean;
  totalCount: number;
  returnedCount: number;
};

export type PsRuntimeSnapshot = {
  rows: ProcessRow[];
  commandRows: ProcessCommandRow[];
};

function parseProcessNumber(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTty(value: string | null | undefined): string | null {
  const normalized = value?.replace(/^\/dev\//u, "").trim();
  if (!normalized || normalized === "??" || normalized === "?") return null;
  return normalized;
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ProbeCommandError
    && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit");
}

function psBin(): string {
  return process.env.OPENSCOUT_PS_BIN?.trim() || "ps";
}

function lsofBin(): string {
  return process.env.OPENSCOUT_LSOF_BIN?.trim() || "lsof";
}

function psDiscoveryMaxRows(): number {
  const parsed = Number.parseInt(process.env.OPENSCOUT_PS_DISCOVERY_MAX_ROWS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PS_DISCOVERY_MAX_ROWS;
}

function truncateCommand(value: string): { command: string; truncated: boolean } {
  if (value.length <= PS_DISCOVERY_MAX_COMMAND_CHARS) {
    return { command: value, truncated: false };
  }
  return {
    command: value.slice(0, PS_DISCOVERY_MAX_COMMAND_CHARS),
    truncated: true,
  };
}

function parseRows(output: string): ProcessRow[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/u);
      const pid = parseProcessNumber(parts[0]);
      const ppid = parseProcessNumber(parts[1]);
      const pgid = parseProcessNumber(parts[2]);
      const tty = normalizeTty(parts[3]);
      const comm = parts.slice(4).join(" ");
      return pid && ppid && pgid && comm ? { pid, ppid, pgid, tty, comm } : null;
    })
    .filter((row): row is ProcessRow => Boolean(row));
}

function parseCommandRows(output: string): ProcessCommandRow[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/u);
      const pid = parseProcessNumber(parts[0]);
      const ppid = parseProcessNumber(parts[1]);
      const pgid = parseProcessNumber(parts[2]);
      const tty = normalizeTty(parts[3]);
      const command = truncateCommand(parts.slice(4).join(" ")).command;
      const comm = command.split(/\s+/u)[0] ?? "";
      return pid && ppid && pgid && comm && command
        ? { pid, ppid, pgid, tty, comm, command }
        : null;
    })
    .filter((row): row is ProcessCommandRow => Boolean(row));
}

function parseDiscoveryRows(output: string): ProcessDiscoveryRow[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u);
      if (!match) return null;
      const pid = parseProcessNumber(match[1]);
      const ppid = parseProcessNumber(match[2]);
      const etime = match[3]?.trim() ?? "";
      const command = match[4]?.trim() ?? "";
      return pid && ppid && etime && command ? { pid, ppid, etime, command } : null;
    })
    .filter((row): row is ProcessDiscoveryRow => Boolean(row));
}

export function summarizeProcessDiscoveryRows(rows: ProcessDiscoveryRow[], maxRows = psDiscoveryMaxRows()): ProcessDiscoverySnapshot {
  const totalCount = rows.length;
  let truncatedCommand = false;
  const cappedRows = rows.slice(0, maxRows).map((row) => {
    const command = truncateCommand(row.command);
    if (command.truncated) truncatedCommand = true;
    return { ...row, command: command.command };
  });
  return {
    rows: cappedRows,
    truncated: totalCount > cappedRows.length || truncatedCommand,
    totalCount,
    returnedCount: cappedRows.length,
  };
}

async function readPsRuntimeLocal(ctx: ProbeCtx): Promise<PsRuntimeSnapshot> {
  try {
    const [rows, commandRows] = await Promise.all([
      execProbeFile(ctx, psBin(), ["-axo", "pid=,ppid=,pgid=,tty=,comm="], {
        maxStdoutBytes: 4 * 1024 * 1024,
        maxStderrBytes: 128 * 1024,
      }),
      execProbeFile(ctx, psBin(), ["-axo", "pid=,ppid=,pgid=,tty=,command="], {
        maxStdoutBytes: 8 * 1024 * 1024,
        maxStderrBytes: 128 * 1024,
      }),
    ]);
    return {
      rows: parseRows(rows.stdout),
      commandRows: parseCommandRows(commandRows.stdout),
    };
  } catch (error) {
    if (isUnavailable(error)) {
      return { rows: [], commandRows: [] };
    }
    throw error;
  }
}

export const psRuntimeProbe = defineProbe<PsRuntimeSnapshot>({
  id: "ps.runtime",
  ttlMs: PS_TTL_MS,
  timeoutMs: PS_TIMEOUT_MS,
  run: (ctx) => runWithScoutdFallback({
    probeId: "ps.runtime",
    ctx,
    local: () => readPsRuntimeLocal(ctx),
  }),
});

async function readPsDiscoveryLocal(ctx: ProbeCtx): Promise<ProcessDiscoverySnapshot> {
  try {
    const { stdout } = await execProbeFile(ctx, psBin(), ["-axww", "-o", "pid=,ppid=,etime=,command="], {
      maxStdoutBytes: 32 * 1024 * 1024,
      maxStderrBytes: 128 * 1024,
    });
    return summarizeProcessDiscoveryRows(parseDiscoveryRows(stdout));
  } catch (error) {
    if (isUnavailable(error)) return summarizeProcessDiscoveryRows([]);
    throw error;
  }
}

export const psDiscoveryProbe = defineProbe<ProcessDiscoverySnapshot>({
  id: "ps.discovery",
  ttlMs: 1_000,
  timeoutMs: PS_TIMEOUT_MS,
  run: (ctx) => runWithScoutdFallback({
    probeId: "ps.discovery",
    ctx,
    local: () => readPsDiscoveryLocal(ctx),
  }),
});

export async function readProcessRowsForTty(tty: string, maxAgeMs = PS_TTL_MS): Promise<ProcessRow[]> {
  const target = normalizeTty(tty);
  if (!target) return [];
  const snapshot = await psRuntimeProbe.fresh({ maxAgeMs });
  return (snapshot.value?.rows ?? []).filter((row) => row.tty === target);
}

export async function readAllProcessRows(maxAgeMs = PS_TTL_MS): Promise<ProcessRow[]> {
  const snapshot = await psRuntimeProbe.fresh({ maxAgeMs });
  return snapshot.value?.rows ?? [];
}

export async function readAllProcessCommandRows(maxAgeMs = PS_TTL_MS): Promise<ProcessCommandRow[]> {
  const snapshot = await psRuntimeProbe.fresh({ maxAgeMs });
  return snapshot.value?.commandRows ?? [];
}

export async function readProcessDiscoveryRows(maxAgeMs = 1_000): Promise<ProcessDiscoveryRow[]> {
  const snapshot = await psDiscoveryProbe.fresh({ maxAgeMs });
  return snapshot.value?.rows ?? [];
}

export async function readProcessField(pid: number, field: "command" | "ppid", maxAgeMs = PS_TTL_MS): Promise<string | null> {
  const snapshot = await psRuntimeProbe.fresh({ maxAgeMs });
  const row = snapshot.value?.commandRows.find((candidate) => candidate.pid === pid);
  if (!row) return null;
  if (field === "command") return row.command;
  return String(row.ppid);
}

export async function pgrepCommand(pattern: RegExp, maxAgeMs = PS_TTL_MS): Promise<ProcessCommandRow[]> {
  const rows = await readAllProcessCommandRows(maxAgeMs);
  return rows.filter((row) => pattern.test(row.command));
}

export const processCwdProbe = defineProbeFamily<number | string, string | null>({
  id: "ps.cwd",
  ttlMs: PS_TTL_MS,
  timeoutMs: 1_500,
  maxKeys: 256,
  idleKeyTtlMs: 2 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: (pid) => String(pid).trim(),
  run: async (key, ctx) => runWithScoutdFallback({
    probeId: "ps.cwd",
    key,
    ctx,
    local: () => readProcessCwdLocal(key, ctx),
  }),
});

async function readProcessCwdLocal(key: string, ctx: ProbeCtx): Promise<string | null> {
  const pid = Number.parseInt(key, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execProbeFile(ctx, lsofBin(), [
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd",
      "-Fn",
    ], {
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    for (const line of stdout.split(/\r?\n/u)) {
      if (!line.startsWith("n")) continue;
      const value = line.slice(1).trim();
      if (value) return value;
    }
    return null;
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
}

export async function readProcessCwd(pid: number, maxAgeMs = PS_TTL_MS): Promise<string | null> {
  const snapshot = await processCwdProbe.for(pid).fresh({ maxAgeMs });
  return snapshot.value ?? null;
}
