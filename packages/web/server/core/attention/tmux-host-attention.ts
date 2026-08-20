import type { WebAgent } from "../../db/types/web.ts";

export type TmuxHostAttentionItem = {
  id: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  title: string;
  summary: string;
  detail: string | null;
  updatedAt: number;
  sourceLabel: string;
};

export type TmuxHostAttentionCapture = (
  agent: WebAgent,
  paneTarget: string,
) => Promise<string | null>;

const CLAUDE_CONFIRMATION_FOOTER = /\bEsc to cancel\b.*\bTab to amend\b/i;
const CLAUDE_PERMISSION_RULE = /\bPermission rule\s+(.+?)\s+requires confirmation for this command\./i;
const CLAUDE_PROCEED_QUESTION = /\bDo you want to proceed\?/i;
const CLAUDE_POST_PROMPT_ACTIVITY = /(?:^|\n)\s*(?:⏺|●)\s+(?:Bash|Edit|Glob|Grep|Read|Search|Task|Update|WebFetch|WebSearch|Write)\b/imu;
const CLAUDE_READY_COMPOSER = /^\s*(?:[❯›]\s*|[│┃]\s*[>❯]\s*)/mu;
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_OSC = /\x1B\][^\x07]*(?:\x07|\x1B\\)/gu;
const MAX_SUMMARY_LENGTH = 200;
const MAX_DETAIL_LENGTH = 500;
const DEFAULT_CAPTURE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CANDIDATES = 24;
const DEFAULT_CAPTURE_CONCURRENCY = 6;

export function detectClaudeTmuxHostAttention(
  paneBody: string,
  input: {
    agentId: string;
    agentName: string;
    sessionId: string;
    now?: number;
  },
): TmuxHostAttentionItem | null {
  const lines = stripTerminalControls(paneBody).split(/\r?\n/u);
  const lastContentIndex = findLastIndex(lines, (line) => line.trim().length > 0);
  if (lastContentIndex < 0) {
    return null;
  }

  const footerIndex = findLastIndex(lines, (line) => CLAUDE_CONFIRMATION_FOOTER.test(line));
  if (footerIndex < 0) {
    return null;
  }
  const contentAfterFooter = lines.slice(footerIndex + 1, lastContentIndex + 1).join("\n");
  if (
    CLAUDE_POST_PROMPT_ACTIVITY.test(contentAfterFooter)
    || CLAUDE_READY_COMPOSER.test(contentAfterFooter)
  ) {
    return null;
  }

  const questionIndex = findLastIndex(
    lines,
    (line, index) => index < footerIndex && CLAUDE_PROCEED_QUESTION.test(line),
  );
  if (questionIndex < 0 || footerIndex - questionIndex > 12) {
    return null;
  }

  const permissionIndex = findLastIndex(
    lines,
    (line, index) => index < questionIndex && CLAUDE_PERMISSION_RULE.test(line),
  );
  if (permissionIndex < 0 || questionIndex - permissionIndex > 8) {
    return null;
  }

  const permission = lines[permissionIndex]?.match(CLAUDE_PERMISSION_RULE)?.[1]?.trim();
  if (!permission) {
    return null;
  }

  return {
    id: `tmux-host-permission:${input.agentId}:${input.sessionId}`,
    agentId: input.agentId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    title: "Claude needs permission",
    summary: clampText(`Permission rule ${permission} requires confirmation.`, MAX_SUMMARY_LENGTH),
    detail: commandDetail(lines, permissionIndex),
    updatedAt: input.now ?? Date.now(),
    sourceLabel: "Claude terminal prompt",
  };
}

export async function collectTmuxHostAttention(
  agents: readonly WebAgent[],
  capture: TmuxHostAttentionCapture,
  options: {
    now?: number;
    captureTimeoutMs?: number;
    maxCandidates?: number;
    captureConcurrency?: number;
  } = {},
): Promise<TmuxHostAttentionItem[]> {
  const candidates = agents.filter((agent) => {
    return agent.harness === "claude"
      && agent.transport === "tmux"
      && !agent.retiredFromFleet
      && !agent.staleLocalRegistration
      && agent.terminalSurface?.backend === "tmux"
      && Boolean(agent.terminalSurface.sessionName.trim());
  }).sort((left, right) =>
    hostAttentionStateRank(left.state) - hostAttentionStateRank(right.state)
    || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || left.id.localeCompare(right.id),
  ).slice(0, Math.max(0, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));

  const items = await mapWithConcurrency(
    candidates,
    options.captureConcurrency ?? DEFAULT_CAPTURE_CONCURRENCY,
    async (agent) => {
      const surface = agent.terminalSurface!;
      const paneTarget = surface.paneId?.trim() || surface.sessionName.trim();
      try {
        const body = await withTimeout(
          capture(agent, paneTarget),
          options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
        );
        return body
          ? detectClaudeTmuxHostAttention(body, {
              agentId: agent.id,
              agentName: agent.name,
              sessionId: surface.sessionName,
              now: options.now,
            })
          : null;
      } catch {
        // Host attention is a best-effort decoration. Pane loss must not make
        // the fleet API fail while tmux is exiting or changing windows.
        return null;
      }
    },
  );

  return items.filter((item): item is TmuxHostAttentionItem => Boolean(item));
}

function hostAttentionStateRank(state: string | null): number {
  const normalized = state?.trim().toLowerCase();
  return normalized === "needs_attention" || normalized === "needs-attention"
    ? 0
    : normalized === "working" || normalized === "active" || normalized === "running" || normalized === "in_turn"
      ? 1
      : normalized === "in_flight" || normalized === "queued" || normalized === "waking" || normalized === "dispatching"
        ? 2
        : 3;
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  requestedConcurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    values.length,
    Math.max(1, Math.floor(requestedConcurrency)),
  );
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

function commandDetail(lines: string[], permissionIndex: number): string | null {
  const headerIndex = findLastIndex(
    lines,
    (line, index) => index < permissionIndex && /^\s*(?:Bash command|Edit file|Write file)\s*$/i.test(line),
  );
  if (headerIndex < 0 || permissionIndex - headerIndex > 12) {
    return null;
  }
  const command = lines
    .slice(headerIndex + 1, permissionIndex)
    .map((line) => line.trim())
    .find(Boolean);
  return command ? clampText(command, MAX_DETAIL_LENGTH) : null;
}

function findLastIndex(
  values: readonly string[],
  predicate: (value: string, index: number) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] ?? "", index)) {
      return index;
    }
  }
  return -1;
}

function clampText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
}

function stripTerminalControls(value: string): string {
  return value.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replaceAll("\r", "");
}
