import { tildeShortenPath } from "../../lib/bash-format.ts";
import { timeAgo } from "../../lib/time.ts";
import { isAgentLaneLive, type AgentLane } from "../../screens/ops/agent-lanes-model.ts";

export type ScopeLaneHeader = {
  source: string;
  sessionRef: string;
  path: string;
  statusLine: string;
  live: boolean;
};

function titleCase(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : "local";
}

function shortPath(path: string): string {
  const normalized = tildeShortenPath(path.trim());
  const parts = normalized.replace(/\/+$/u, "").split(/[\\/]/u).filter(Boolean);
  return parts.length === 0 ? normalized : parts.slice(-2).join("/");
}

function shortSessionRef(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "—";
  return trimmed.replace(/\.jsonl$/u, "").slice(0, 8);
}

export function buildScopeLaneHeader(lane: AgentLane, nowMs = Date.now()): ScopeLaneHeader {
  const { agent, source, observe, lastActiveAt } = lane;
  const harness = agent.harness?.trim() || source;
  const live = isAgentLaneLive(observe);
  const path = shortPath(agent.cwd || agent.project || agent.projectRoot || "—");
  const statusLine = live
    ? `${harness} · live`
    : `${harness} · ${timeAgo(lastActiveAt ?? nowMs)}`;

  return {
    source: titleCase(harness),
    sessionRef: shortSessionRef(agent.harnessSessionId),
    path,
    statusLine,
    live,
  };
}