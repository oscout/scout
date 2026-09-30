/**
 * Continuation over Herdr-hosted Claude panes.
 *
 * Sensor is Herdr `blocked` plus a live visible snapshot. The manager decides.
 * `continue` sends the recorded Yes keys only after a second identical read.
 * Notify stays fail-closed. Without `sendKeys`, this is shadow: log the
 * would-be act and still surface attention.
 *
 * Opt-in only: each pane's level comes from `policyFor`, which in production
 * reads the operator's grant file. No grant is `ask`, which never continues,
 * never consults the model, and never sends keys. Every send attempt is
 * written through `audit` before the pane is released.
 */

import type { HerdrPaneProjection, HerdrSessionTopology } from "@openscout/protocol";
import {
  decideContinuationWithModel,
  sameContinuationDecision,
  type ContinuationLevel,
  type ContinuationModel,
  type ContinuationVerdict,
} from "@openscout/runtime";

import type { TmuxHostAttentionItem } from "./tmux-host-attention.ts";

export type HerdrContinuationAgent = {
  id: string;
  name: string;
  harness: string | null;
  cwd?: string | null;
  projectRoot?: string | null;
  retiredFromFleet?: boolean;
  terminalSurface?: {
    backend: string;
    sessionName: string;
    paneId?: string | null;
  } | null;
};

export type HerdrContinuationStop = TmuxHostAttentionItem & {
  herdrSession: string;
  paneId: string;
  verdict: ContinuationVerdict & { shadow: boolean };
};

export type HerdrContinuationCapture = (
  sessionName: string,
  pane: HerdrPaneProjection,
) => Promise<string | null>;

export type HerdrContinuationSendKeys = (
  sessionName: string,
  target: string,
  keys: readonly string[],
) => Promise<void>;

export type HerdrContinuationGrant = {
  level: ContinuationLevel;
  /** Which grant applied (for the audit row), e.g. `project:/path`. */
  source: string;
  /** The operator also allowed the cheap model on this pane. */
  allowModel?: boolean;
};

/** Level for one pane. Absent means every pane is `ask`. */
export type HerdrContinuationPolicyFor = (
  sessionName: string,
  pane: HerdrPaneProjection,
) => HerdrContinuationGrant;

export type HerdrContinuationAuditRecord = {
  at: number;
  outcome: "attempt" | "sent" | "failed" | "mismatch" | "claimed-elsewhere";
  herdrSession: string;
  paneId: string;
  level: ContinuationLevel;
  grant: string;
  command: string | null;
  risk: string;
  keys: readonly string[] | null;
  source: "rules" | "model";
  reason: string;
};

export type HerdrContinuationAudit = (record: HerdrContinuationAuditRecord) => void;

/** Cross-process claim on a pane prompt; false means someone else has it. */
export type HerdrContinuationClaim = (key: string, ttlMs: number) => boolean;

const ASK_GRANT: HerdrContinuationGrant = { level: "ask", source: "default", allowModel: false };

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_PANES = 24;
const DEFAULT_CAPTURE_TIMEOUT_MS = 2_000;
const DEFAULT_CAPTURE_CONCURRENCY = 6;
const ACTUATION_TTL_MS = 30_000;

const recentlyActuated = new Map<string, { command: string | null; at: number }>();
const inFlightActuation = new Set<string>();

export function resetHerdrContinuationActuation(): void {
  recentlyActuated.clear();
  inFlightActuation.clear();
}

export function herdrBlockedClaudePanes(
  topology: HerdrSessionTopology,
): HerdrPaneProjection[] {
  if (!topology.running) return [];
  const panes: HerdrPaneProjection[] = [];
  for (const workspace of topology.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agentStatus !== "blocked") continue;
        if (!isClaudeAgent(pane.agent)) continue;
        panes.push(pane);
      }
    }
  }
  return panes;
}

export function formatContinuationAttention(
  verdict: ContinuationVerdict & { shadow: boolean },
  sentFailed = false,
): {
  title: string;
  summary: string;
} {
  const command = verdict.command ?? "Claude is waiting";
  if (sentFailed) {
    return {
      title: "Claude needs permission",
      summary: `Could not continue · ${command}`,
    };
  }
  if (verdict.shadow && verdict.act === "continue") {
    return {
      title: "Claude needs permission",
      summary: `Would continue · ${command}`,
    };
  }
  if (verdict.kind === "hold") {
    return {
      title: "Claude held an action",
      summary: verdict.shadow ? `Would notify · ${command}` : command,
    };
  }
  return {
    title: "Claude needs permission",
    summary: verdict.shadow ? `Would notify · ${command}` : command,
  };
}

export async function collectHerdrContinuationStops(input: {
  listSessions: () => Promise<readonly { name: string; running?: boolean }[]>;
  readTopology: (sessionName: string) => Promise<HerdrSessionTopology>;
  capture: HerdrContinuationCapture;
  sendKeys?: HerdrContinuationSendKeys;
  model?: ContinuationModel | null;
  agents?: readonly HerdrContinuationAgent[];
  policyFor?: HerdrContinuationPolicyFor;
  /** Required for actuation: no audit sink means shadow. */
  audit?: HerdrContinuationAudit;
  claim?: HerdrContinuationClaim;
  now?: number;
  maxSessions?: number;
  maxPanes?: number;
  captureTimeoutMs?: number;
  captureConcurrency?: number;
}): Promise<HerdrContinuationStop[]> {
  const now = input.now ?? Date.now();
  // Keys are only ever sent with an audit sink attached.
  const shadow = !input.sendKeys || !input.audit;
  let sessions: readonly { name: string; running?: boolean }[] = [];
  try {
    sessions = await input.listSessions();
  } catch {
    return [];
  }

  const running = sessions
    .filter((session) => session.running !== false)
    .slice(0, Math.max(0, input.maxSessions ?? DEFAULT_MAX_SESSIONS));

  const blocked: Array<{ sessionName: string; pane: HerdrPaneProjection }> = [];
  for (const session of running) {
    try {
      const topology = await input.readTopology(session.name);
      for (const pane of herdrBlockedClaudePanes(topology)) {
        blocked.push({ sessionName: session.name, pane });
      }
    } catch {
      // A single unreachable session must not take the rest of attention down.
    }
  }

  const candidates = blocked.slice(0, Math.max(0, input.maxPanes ?? DEFAULT_MAX_PANES));
  const timeoutMs = input.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const items = await mapWithConcurrency(
    candidates,
    input.captureConcurrency ?? DEFAULT_CAPTURE_CONCURRENCY,
    async ({ sessionName, pane }) => {
      try {
        const paneId = pane.terminalId ?? pane.paneId;
        const grant = resolveGrant(input.policyFor, sessionName, pane);
        const policy = grant.level;
        // `ask` never continues, so the model has nothing to decide and must
        // not see the pane. Elsewhere it needs the operator's explicit allow.
        const model = policy !== "ask" && grant.allowModel ? input.model ?? null : null;
        const body = await withTimeout(input.capture(sessionName, pane), timeoutMs);
        if (!body) return null;
        const first = await decideContinuationWithModel({
          paneBody: body,
          policy,
          model,
        });
        if (!first.live) return null;

        if (!shadow && policy !== "ask" && first.act === "continue" && first.keys) {
          const sent = await actuateContinue({
            sessionName,
            pane,
            paneId,
            first,
            capture: input.capture,
            sendKeys: input.sendKeys!,
            audit: input.audit!,
            claim: input.claim,
            readTopology: input.readTopology,
            policyFor: input.policyFor,
            grant,
            model,
            policy,
            timeoutMs,
            now,
          });
          if (sent === "sent" || sent === "recent") return null;
          if (sent === "failed") {
            return toStop({
              sessionName,
              pane,
              paneId,
              verdict: { ...first, shadow: false },
              agents: input.agents ?? [],
              now,
              sentFailed: true,
            });
          }
          // mismatch: fall through with a fresh decide from the second read
          // `sent` holds that verdict.
          const mismatch = sent;
          if (!mismatch.live) return null;
          return toStop({
            sessionName,
            pane,
            paneId,
            verdict: { ...mismatch, shadow: false },
            agents: input.agents ?? [],
            now,
          });
        }

        return toStop({
          sessionName,
          pane,
          paneId,
          verdict: { ...first, shadow },
          agents: input.agents ?? [],
          now,
        });
      } catch {
        return null;
      }
    },
  );
  return items.filter((item): item is HerdrContinuationStop => Boolean(item));
}

async function actuateContinue(input: {
  sessionName: string;
  pane: HerdrPaneProjection;
  paneId: string;
  first: ContinuationVerdict;
  capture: HerdrContinuationCapture;
  sendKeys: HerdrContinuationSendKeys;
  audit: HerdrContinuationAudit;
  claim?: HerdrContinuationClaim;
  readTopology: (sessionName: string) => Promise<HerdrSessionTopology>;
  policyFor?: HerdrContinuationPolicyFor;
  grant: HerdrContinuationGrant;
  model?: ContinuationModel | null;
  policy: ContinuationLevel;
  timeoutMs: number;
  now: number;
}): Promise<"sent" | "recent" | "failed" | ContinuationVerdict> {
  const key = `${input.sessionName}:${input.paneId}`;
  const recent = recentlyActuated.get(key);
  if (
    recent
    && input.now - recent.at < ACTUATION_TTL_MS
    && recent.command === input.first.command
  ) {
    return "recent";
  }
  // Claim the pane in-process before any await so a concurrent snapshot in
  // this server cannot race us to the same prompt.
  if (inFlightActuation.has(key)) return "recent";
  inFlightActuation.add(key);
  try {
    const record = (
      outcome: HerdrContinuationAuditRecord["outcome"],
      verdict: ContinuationVerdict,
    ): boolean => {
      try {
        input.audit({
          at: input.now,
          outcome,
          herdrSession: input.sessionName,
          paneId: input.paneId,
          level: input.policy,
          grant: input.grant.source,
          command: verdict.command,
          risk: verdict.risk,
          keys: verdict.keys,
          source: verdict.source,
          reason: verdict.reason,
        });
        return true;
      } catch {
        return false;
      }
    };

    const confirmedBody = await withTimeout(input.capture(input.sessionName, input.pane), input.timeoutMs);
    if (!confirmedBody) return "failed";
    const second = await decideContinuationWithModel({
      paneBody: confirmedBody,
      policy: input.policy,
      model: input.model,
    });
    if (!sameContinuationDecision(input.first, second) || second.act !== "continue" || !second.keys) {
      record("mismatch", second);
      return second;
    }

    // Authority is re-read at the last moment: the pane must still be the
    // same blocked Claude pane, and the operator's grant (fresh from the
    // file, against the pane's current directories) must still be this level.
    const fresh = await withTimeout(
      input.readTopology(input.sessionName).catch(() => null),
      input.timeoutMs,
    );
    const livePane = fresh
      ? herdrBlockedClaudePanes(fresh).find((candidate) =>
        candidate.paneId === input.pane.paneId
        && (candidate.terminalId ?? candidate.paneId) === input.paneId)
      : null;
    const freshGrant = livePane ? resolveGrant(input.policyFor, input.sessionName, livePane) : ASK_GRANT;
    if (!livePane || freshGrant.level !== input.policy || freshGrant.source !== input.grant.source) {
      const revoked: ContinuationVerdict = {
        ...second,
        act: "notify",
        keys: null,
        reason: livePane ? "grant changed before send" : "pane changed before send",
      };
      record("mismatch", revoked);
      return revoked;
    }

    const claimKey = `${key}:${second.command ?? ""}`;
    if (input.claim && !input.claim(claimKey, ACTUATION_TTL_MS)) {
      record("claimed-elsewhere", second);
      return "recent";
    }
    // No audit row, no keys.
    if (!record("attempt", second)) return "failed";
    try {
      await input.sendKeys(input.sessionName, input.paneId, second.keys);
      recentlyActuated.set(key, { command: second.command, at: input.now });
      record("sent", second);
      return "sent";
    } catch {
      record("failed", second);
      return "failed";
    }
  } finally {
    inFlightActuation.delete(key);
  }
}

function resolveGrant(
  policyFor: HerdrContinuationPolicyFor | undefined,
  sessionName: string,
  pane: HerdrPaneProjection,
): HerdrContinuationGrant {
  if (!policyFor) return ASK_GRANT;
  try {
    return policyFor(sessionName, pane);
  } catch {
    return ASK_GRANT;
  }
}

function toStop(input: {
  sessionName: string;
  pane: HerdrPaneProjection;
  paneId: string;
  verdict: ContinuationVerdict & { shadow: boolean };
  agents: readonly HerdrContinuationAgent[];
  now: number;
  sentFailed?: boolean;
}): HerdrContinuationStop {
  const copy = formatContinuationAttention(input.verdict, input.sentFailed);
  const agent = matchContinuationAgent(input.agents, input.sessionName, input.pane);
  return {
    id: `herdr-continuation:${input.sessionName}:${input.paneId}`,
    agentId: agent?.id ?? `herdr:${input.sessionName}:${input.paneId}`,
    agentName: agent?.name ?? input.pane.label ?? input.pane.agent ?? "claude",
    sessionId: input.sessionName,
    title: copy.title,
    summary: copy.summary,
    detail: input.verdict.command,
    updatedAt: input.now,
    sourceLabel: input.verdict.shadow ? "Herdr continuation (shadow)" : "Herdr continuation",
    herdrSession: input.sessionName,
    paneId: input.paneId,
    verdict: input.verdict,
  };
}

function isClaudeAgent(agent: string | null): boolean {
  return Boolean(agent && /\bclaude\b/i.test(agent));
}

function matchContinuationAgent(
  agents: readonly HerdrContinuationAgent[],
  sessionName: string,
  pane: HerdrPaneProjection,
): HerdrContinuationAgent | null {
  const directory = pane.foregroundCwd ?? pane.cwd;
  const scored = agents
    .filter((agent) => !agent.retiredFromFleet && isClaudeAgent(agent.harness))
    .map((agent) => {
      let score = 0;
      const surface = agent.terminalSurface;
      if (surface?.backend === "herdr" && surface.sessionName === sessionName) {
        score += 4;
        if (surface.paneId && (surface.paneId === pane.paneId || surface.paneId === pane.terminalId)) {
          score += 4;
        }
      }
      if (directory && (agent.cwd === directory || agent.projectRoot === directory)) {
        score += 2;
      }
      return { agent, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  return scored[0]?.agent ?? null;
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  requestedConcurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(requestedConcurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
