import { basename } from "node:path";

import type { DiscoveredProcess, TailEvent } from "@openscout/runtime/tail";
import type { Broadcast, BroadcastContext, BroadcastRule } from "./types.ts";

const IDLE_THRESHOLD_MS = 5 * 60_000;
const IDLE_RECENT_WINDOW_MS = 60 * 60_000;
const TOOL_FAILURE_WINDOW_MS = 60_000;
const TOOL_FAILURE_THRESHOLD = 3;

function projectFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return "(unknown)";
  return basename(cwd) || "(unknown)";
}

function agentLabelForProcess(p: DiscoveredProcess): string {
  return `${projectFromCwd(p.cwd)}#${p.pid}`;
}

function agentLabelForEvent(e: TailEvent): string {
  const project = e.project || "(unknown)";
  const short = e.sessionId ? e.sessionId.slice(0, 8) : String(e.pid);
  return `${project}#${short}`;
}

function makeBroadcast(
  ruleId: string,
  tier: Broadcast["tier"],
  key: string,
  text: string,
  ts: number,
  extra: { agent?: string; project?: string } = {},
): Broadcast {
  return {
    id: `${ruleId}:${ts}:${key}`,
    tier,
    text,
    ts,
    ruleId,
    key,
    ...extra,
  };
}

export const fleetActivityRule: BroadcastRule = {
  id: "fleet-activity",
  tier: "info",
  cooldownMs: 5 * 60_000,
  evaluate(ctx: BroadcastContext): Broadcast[] | null {
    const prev = ctx.previousDiscovery;
    const cur = ctx.discovery;
    if (!prev) return null;
    const totalDelta = Math.abs(cur.totals.total - prev.totals.total);
    const unattributedDelta = Math.abs(
      cur.totals.unattributed - prev.totals.unattributed,
    );
    if (totalDelta < 1 && unattributedDelta < 1) return null;
    const active = cur.totals.scoutManaged + cur.totals.hudsonManaged;
    const text = `${cur.totals.total} agents tracked, ${active} active. ${cur.totals.unattributed} unattributed.`;
    const key = `fleet-activity:total=${cur.totals.total}:active=${active}:unattributed=${cur.totals.unattributed}`;
    return [makeBroadcast(this.id, this.tier, key, text, ctx.now)];
  },
};

export const agentIdleRule: BroadcastRule = {
  id: "agent-idle",
  tier: "warn",
  cooldownMs: 10 * 60_000,
  evaluate(ctx: BroadcastContext): Broadcast[] | null {
    if (ctx.recentEvents.length === 0 && ctx.discovery.processes.length === 0) {
      return null;
    }
    const lastEventByPid = new Map<number, TailEvent>();
    for (const event of ctx.recentEvents) {
      const existing = lastEventByPid.get(event.pid);
      if (!existing || event.ts > existing.ts) {
        lastEventByPid.set(event.pid, event);
      }
    }
    const out: Broadcast[] = [];
    for (const proc of ctx.discovery.processes) {
      const last = lastEventByPid.get(proc.pid);
      if (!last) continue;
      const sinceLast = ctx.now - last.ts;
      // Was active in last hour and now idle ≥5 min.
      if (sinceLast >= IDLE_THRESHOLD_MS && sinceLast <= IDLE_RECENT_WINDOW_MS) {
        const minutes = Math.floor(sinceLast / 60_000);
        const project = projectFromCwd(proc.cwd);
        const agent = agentLabelForProcess(proc);
        const text = `${agent} on ${project} idle ${minutes} min.`;
        const key = `agent-idle:${proc.pid}`;
        out.push(
          makeBroadcast(this.id, this.tier, key, text, ctx.now, {
            agent,
            project,
          }),
        );
      }
    }
    return out.length ? out : null;
  },
};

function isErrorToolResult(event: TailEvent): boolean {
  if (event.kind !== "tool-result") return false;
  const text = event.summary.toLowerCase();
  return text.includes("error") || text.includes("failed");
}

function toolNameFromSummary(summary: string): string {
  // assistant blocks summarise tool_use as `name(args)` and tool_result as `→ ...`.
  // For the result we don't have the tool name directly. Use the previous tool_use
  // by sessionId if available; here we fall back to "tool".
  const match = summary.match(/^(\w[\w-]*)\(/);
  return match?.[1] ?? "tool";
}

export const repeatedToolFailureRule: BroadcastRule = {
  id: "repeated-tool-failure",
  tier: "warn",
  cooldownMs: 5 * 60_000,
  evaluate(ctx: BroadcastContext): Broadcast[] | null {
    const cutoff = ctx.now - TOOL_FAILURE_WINDOW_MS;
    // Group by pid; remember last tool_use name per session for labelling.
    const lastToolBySession = new Map<string, string>();
    const failuresByPid = new Map<number, { count: number; tool: string; project: string }>();
    for (const event of ctx.recentEvents) {
      if (event.ts < cutoff) continue;
      if (event.kind === "tool") {
        lastToolBySession.set(event.sessionId, toolNameFromSummary(event.summary));
        continue;
      }
      if (!isErrorToolResult(event)) continue;
      const tool = lastToolBySession.get(event.sessionId) ?? "tool";
      const existing = failuresByPid.get(event.pid);
      if (existing) {
        existing.count++;
        // Keep the tool name from the first failure in the window.
      } else {
        failuresByPid.set(event.pid, {
          count: 1,
          tool,
          project: event.project,
        });
      }
    }
    const out: Broadcast[] = [];
    for (const [pid, info] of failuresByPid) {
      if (info.count < TOOL_FAILURE_THRESHOLD) continue;
      const agent = `${info.project}#${pid}`;
      const text = `${agent} repeated ${info.tool} failures on ${info.project}.`;
      const key = `repeated-tool-failure:${pid}:${info.tool}`;
      out.push(
        makeBroadcast(this.id, this.tier, key, text, ctx.now, {
          agent,
          project: info.project,
        }),
      );
    }
    return out.length ? out : null;
  },
};

export const agentExitedRule: BroadcastRule = {
  id: "agent-exited",
  tier: "error",
  cooldownMs: 0,
  evaluate(ctx: BroadcastContext): Broadcast[] | null {
    const prev = ctx.previousDiscovery;
    if (!prev) return null;
    const currentPids = new Set(ctx.discovery.processes.map((p) => p.pid));
    const out: Broadcast[] = [];
    for (const proc of prev.processes) {
      if (currentPids.has(proc.pid)) continue;
      if (ctx.seenExits.has(proc.pid)) continue;
      ctx.seenExits.add(proc.pid);
      const project = projectFromCwd(proc.cwd);
      const agent = agentLabelForProcess(proc);
      const text = `${agent} on ${project} exited.`;
      const key = `agent-exited:${proc.pid}`;
      out.push(
        makeBroadcast(this.id, this.tier, key, text, ctx.now, {
          agent,
          project,
        }),
      );
    }
    return out.length ? out : null;
  },
};

export const allRules: BroadcastRule[] = [
  fleetActivityRule,
  agentIdleRule,
  repeatedToolFailureRule,
  agentExitedRule,
];

export { agentLabelForEvent, agentLabelForProcess, projectFromCwd };
