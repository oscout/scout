import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { queryAgentById } from "./db/agents.ts";
import {
  loadAgentObservePayload,
  loadSessionRefObservePayload,
} from "./core/observe/service.ts";

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function realpathIfExists(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

function resolveObservedPath(
  targetPath: string,
  cwd: string | null | undefined,
): string | null {
  const expanded = expandHomePath(targetPath.trim());
  if (!expanded) {
    return null;
  }
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  if (!cwd?.trim()) {
    return null;
  }
  return resolve(expandHomePath(cwd.trim()), expanded);
}

export async function loadRevealObservePayload(input: {
  agentId?: string | null;
  sessionId?: string | null;
}) {
  const agentId = input.agentId?.trim() || null;
  const sessionId = input.sessionId?.trim() || null;
  if (agentId) {
    const activePayload = await loadAgentObservePayload(agentId);
    if (activePayload && (!sessionId || activePayload.sessionId === sessionId)) {
      return activePayload;
    }
  }

  if (sessionId) {
    const refPayload = await loadSessionRefObservePayload(sessionId);
    if (refPayload && (!agentId || refPayload.agentId === null || refPayload.agentId === agentId)) {
      return refPayload;
    }
  }

  return null;
}

export function observedRevealPathSet(payload: Awaited<ReturnType<typeof loadRevealObservePayload>>): Set<string> {
  const allowed = new Set<string>();
  const session = payload?.data.metadata?.session;
  const cwd = session?.cwd ?? null;
  const candidates = [
    payload?.historyPath,
    cwd,
    session?.threadPath,
    ...(payload?.data.files.map((file) => file.path) ?? []),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const resolved = resolveObservedPath(candidate, cwd);
    const real = resolved ? realpathIfExists(resolved) : null;
    if (real) {
      allowed.add(real);
    }
  }

  return allowed;
}

export type LoadedObservePayload = NonNullable<Awaited<ReturnType<typeof loadRevealObservePayload>>>;

export function observedWorktreePath(payload: LoadedObservePayload): string | null {
  const sessionCwd = payload.data.metadata?.session?.cwd?.trim();
  if (sessionCwd) {
    return resolve(expandHomePath(sessionCwd));
  }
  if (payload.agentId) {
    const agent = queryAgentById(payload.agentId);
    const agentPath = agent?.cwd?.trim() || agent?.projectRoot?.trim();
    if (agentPath) {
      return resolve(expandHomePath(agentPath));
    }
  }
  return null;
}

export function sessionDiffInclude(value: string | undefined): "changed" | "all" {
  return value === "all" || value === "touched" ? "all" : "changed";
}

export function sessionDiffTouchedPaths(payload: LoadedObservePayload, include: "changed" | "all"): string[] {
  return payload.data.files
    .filter((file) => include === "all" || file.state !== "read")
    .map((file) => file.path);
}

export function sessionTouchedResponse(payload: LoadedObservePayload, refId: string | null) {
  const worktreePath = observedWorktreePath(payload);
  const changedFiles = payload.data.files.filter((file) => file.state !== "read").length;
  return {
    schema: "openscout.session.touched/v1",
    refId,
    agentId: payload.agentId,
    sessionId: payload.sessionId,
    source: payload.source,
    fidelity: payload.fidelity,
    historyPath: payload.historyPath,
    worktreePath,
    counts: {
      files: payload.data.files.length,
      changedFiles,
      readFiles: payload.data.files.length - changedFiles,
    },
    files: payload.data.files,
  };
}
