import type { DiscoveredProcess, TailAttribution } from "./types.js";
import { readProcessCwd, readProcessDiscoveryRows } from "../system-probes/ps.js";

const PARENT_HOP_LIMIT = 10;
const PROCESS_LIST_CACHE_MS = readNonNegativeIntEnv("OPENSCOUT_TAIL_PROCESS_CACHE_MS", 1000);

export type RawProcess = {
  pid: number;
  ppid: number;
  etime: string;
  command: string;
};

let processListCache: { expiresAt: number; promise: Promise<RawProcess[]> } | null = null;

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

async function readProcessListUncached(): Promise<RawProcess[]> {
  return await readProcessDiscoveryRows(PROCESS_LIST_CACHE_MS);
}

export async function listProcesses(): Promise<RawProcess[]> {
  const now = Date.now();
  if (processListCache && now < processListCache.expiresAt) {
    return processListCache.promise;
  }

  let promise = readProcessListUncached();
  promise = promise.catch((error) => {
    if (processListCache?.promise === promise) {
      processListCache = null;
    }
    throw error;
  });
  processListCache = {
    expiresAt: now + PROCESS_LIST_CACHE_MS,
    promise,
  };
  return promise;
}

export function commandBasename(command: string): string {
  const firstToken = command.split(/\s+/)[0] ?? "";
  const slashIdx = firstToken.lastIndexOf("/");
  return slashIdx >= 0 ? firstToken.slice(slashIdx + 1) : firstToken;
}

export function isClaudeBinary(command: string): boolean {
  const base = commandBasename(command);
  if (base === "claude") return true;
  if (base.startsWith("claude ")) return true;
  // Reject anything else even if "claude" appears in args (e.g. helpers).
  return false;
}

export async function readCwd(pid: number): Promise<string | null> {
  return await readProcessCwd(pid, 1_000);
}

export function classifyAttribution(parentChain: { command: string }[]): TailAttribution {
  for (const ancestor of parentChain) {
    const cmd = ancestor.command.toLowerCase();
    if (cmd.includes("/openscout") || cmd.includes("openscout/") || cmd.includes("packages/runtime")) {
      return "scout-managed";
    }
    if (cmd.includes("/hudson") || cmd.includes("dev/hudson") || cmd.includes("hudson/")) {
      return "hudson-managed";
    }
  }
  return "unattributed";
}

/** @deprecated Use classifyAttribution. */
export const classifyHarness = classifyAttribution;

export function buildParentChain(
  startPid: number,
  byPid: Map<number, RawProcess>,
): { pid: number; command: string }[] {
  const chain: { pid: number; command: string }[] = [];
  let cursor = byPid.get(startPid)?.ppid ?? 0;
  let hops = 0;
  const seen = new Set<number>();
  while (cursor > 1 && hops < PARENT_HOP_LIMIT && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byPid.get(cursor);
    if (!parent) break;
    chain.push({ pid: parent.pid, command: parent.command });
    cursor = parent.ppid;
    hops++;
  }
  return chain;
}

export async function discoverClaudeProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const claudes = all.filter((p) => isClaudeBinary(p.command));
  const out: DiscoveredProcess[] = [];

  await Promise.all(
    claudes.map(async (proc) => {
      const cwd = await readCwd(proc.pid);
      const parentChain = buildParentChain(proc.pid, byPid);
      const harness = classifyAttribution(parentChain);
      out.push({
        pid: proc.pid,
        ppid: proc.ppid,
        command: proc.command,
        etime: proc.etime,
        cwd,
        harness,
        parentChain,
        source: "claude",
      });
    }),
  );

  out.sort((a, b) => a.pid - b.pid);
  return out;
}
