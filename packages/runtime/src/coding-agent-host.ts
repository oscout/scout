import type { RuntimeEnv } from "./portable-types.js";
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type CodingAgentHarness = "scout" | "cursor" | "claude" | "codex";

export type CodingAgentHostMatch = {
  harness: CodingAgentHarness;
  /** Env var that triggered detection — shown in scout whoami for transparency. */
  signal: string;
};

type HarnessSignal = {
  harness: CodingAgentHarness;
  signal: string;
  matches: (env: RuntimeEnv) => boolean;
};

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized ? TRUTHY.has(normalized) : false;
}

function hasNonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function envEquals(env: RuntimeEnv, key: string, expected: string): boolean {
  return env[key]?.trim().toLowerCase() === expected;
}

/** Vendor-documented subprocess/host signals for the top harnesses Scout routes.
 *  Order matters: Scout binding wins, then the most specific vendor flags. */
const HARNESS_SIGNALS: HarnessSignal[] = [
  {
    harness: "scout",
    signal: "OPENSCOUT_AGENT",
    matches: (env) => hasNonEmpty(env.OPENSCOUT_AGENT),
  },
  {
    harness: "scout",
    signal: "OPENSCOUT_MANAGED_AGENT",
    matches: (env) => isTruthyFlag(env.OPENSCOUT_MANAGED_AGENT),
  },
  {
    harness: "cursor",
    signal: "CURSOR_AGENT",
    matches: (env) => isTruthyFlag(env.CURSOR_AGENT),
  },
  {
    harness: "claude",
    signal: "CLAUDECODE",
    matches: (env) => isTruthyFlag(env.CLAUDECODE),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_CHILD_SESSION",
    matches: (env) => isTruthyFlag(env.CLAUDE_CODE_CHILD_SESSION),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_REMOTE",
    matches: (env) => isTruthyFlag(env.CLAUDE_CODE_REMOTE),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_SESSION_ID",
    matches: (env) => hasNonEmpty(env.CLAUDE_CODE_SESSION_ID),
  },
  {
    harness: "claude",
    signal: "CLAUDE_SESSION_ID",
    matches: (env) => hasNonEmpty(env.CLAUDE_SESSION_ID),
  },
  {
    harness: "claude",
    signal: "CLAUDE_CODE_REMOTE_SESSION_ID",
    matches: (env) => hasNonEmpty(env.CLAUDE_CODE_REMOTE_SESSION_ID),
  },
  {
    harness: "codex",
    signal: "AGENT",
    matches: (env) => envEquals(env, "AGENT", "codex"),
  },
  {
    harness: "codex",
    signal: "CODEX_THREAD_ID",
    matches: (env) => hasNonEmpty(env.CODEX_THREAD_ID),
  },
  {
    harness: "codex",
    signal: "OPENSCOUT_CODEX_THREAD_ID",
    matches: (env) => hasNonEmpty(env.OPENSCOUT_CODEX_THREAD_ID),
  },
  {
    harness: "codex",
    signal: "CODEX_CI",
    matches: (env) => isTruthyFlag(env.CODEX_CI),
  },
  {
    harness: "codex",
    signal: "CODEX_SANDBOX",
    matches: (env) => hasNonEmpty(env.CODEX_SANDBOX),
  },
];

/** Identify which top harness host spawned this shell, if any. */
export function detectCodingAgentHost(
  env: RuntimeEnv = process.env,
): CodingAgentHostMatch | null {
  for (const entry of HARNESS_SIGNALS) {
    if (entry.matches(env)) {
      return { harness: entry.harness, signal: entry.signal };
    }
  }
  return null;
}

/** True when the current process looks like a coding-agent host rather than a
 *  human operator shell. */
export function isCodingAgentHost(env: RuntimeEnv = process.env): boolean {
  return detectCodingAgentHost(env) !== null;
}
