import type { RuntimeEnv } from "./portable-types.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isTestRunnerProcess } from "./support-paths.js";

import {
  claudeStatuslineCommandWrapperPath,
  isClaudeStatuslineWrapperIsolatedFromSettings,
  isOpenScoutClaudeStatuslineCommand,
  resolveClaudeStatuslineLatestPath,
  resolveClaudeStatuslineWrapperPath,
} from "./claude-statusline.js";
import {
  installClaudeStatuslineTool,
  type ClaudeStatuslineInstallReport,
} from "./setup.js";

const DEFAULT_STATUSLINE_FRESHNESS_MS = 5 * 60 * 1000;

export type ProviderTelemetryBootstrapReport = {
  skipped: boolean;
  reason?: "disabled";
  claude: {
    settingsPath: string;
    wrapperPath: string;
    status:
      | "installed"
      | "already-installed"
      | "skipped"
      | "error";
    reason?: "settings-missing" | "disabled" | "owned-by-other-install" | "isolated-support-directory";
    command?: string;
    previousCommand?: string;
    error?: string;
  };
  statuslineLatest: {
    path: string;
    status: "fresh" | "stale" | "missing" | "unreadable";
    capturedAt?: number;
    ageMs?: number;
    sessionId?: string;
    cwd?: string;
  };
};

function resolveHomeDirectory(env: RuntimeEnv): string {
  return env.HOME?.trim() || homedir();
}

function resolveClaudeSettingsPath(env: RuntimeEnv): string {
  return join(resolveHomeDirectory(env), ".claude", "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The wrapper execs an absolute scout path baked in at install time. If that
 * binary moved (reinstall, new prefix), the wrapper fails on every render and
 * capture stops, so a missing target means "not installed".
 */
async function wrapperExecTargetExists(wrapperPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(wrapperPath, "utf8");
  } catch {
    return false;
  }
  const target = content.match(/^exec\s+'([^']+)'/mu)?.[1];
  if (!target || !target.startsWith("/")) return true;
  return existsSync(target);
}

async function readClaudeStatuslineCommand(settingsPath: string): Promise<string | undefined> {
  const settings = await readJsonRecord(settingsPath);
  const statusLine = isRecord(settings?.statusLine) ? settings.statusLine : null;
  return stringValue(statusLine?.command);
}

async function readStatuslineLatest(
  freshnessMs: number,
): Promise<ProviderTelemetryBootstrapReport["statuslineLatest"]> {
  const path = resolveClaudeStatuslineLatestPath();
  if (!existsSync(path)) {
    return { path, status: "missing" };
  }

  const latest = await readJsonRecord(path);
  if (!latest) {
    return { path, status: "unreadable" };
  }

  const workspace = isRecord(latest.workspace) ? latest.workspace : null;
  const capturedAt = timestampMs(latest.openscoutCapturedAt)
    ?? timestampMs(latest.capturedAt)
    ?? timestampMs(latest.timestamp);
  const ageMs = capturedAt === undefined ? undefined : Math.max(0, Date.now() - capturedAt);
  const status = ageMs !== undefined && ageMs <= freshnessMs ? "fresh" : "stale";

  const cwd = stringValue(latest.cwd) ?? stringValue(workspace?.current_dir);

  return {
    path,
    status,
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(ageMs === undefined ? {} : { ageMs }),
    ...(stringValue(latest.session_id) ? { sessionId: stringValue(latest.session_id) } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function reportFromInstall(
  install: ClaudeStatuslineInstallReport,
): ProviderTelemetryBootstrapReport["claude"] {
  return {
    settingsPath: install.settingsPath,
    wrapperPath: install.wrapperPath,
    status: install.status,
    ...(install.reason ? { reason: install.reason } : {}),
    command: install.command,
    ...(install.previousCommand ? { previousCommand: install.previousCommand } : {}),
    ...(install.error ? { error: install.error } : {}),
  };
}

export async function ensureProviderTelemetryBootstrap(options: {
  env?: RuntimeEnv;
  statuslineFreshnessMs?: number;
} = {}): Promise<ProviderTelemetryBootstrapReport> {
  const env = options.env ?? process.env;
  const settingsPath = resolveClaudeSettingsPath(env);
  const wrapperPath = resolveClaudeStatuslineWrapperPath();
  const freshnessMs = options.statuslineFreshnessMs ?? DEFAULT_STATUSLINE_FRESHNESS_MS;

  if (env.OPENSCOUT_PROVIDER_TELEMETRY_BOOTSTRAP === "0") {
    return {
      skipped: true,
      reason: "disabled",
      claude: {
        settingsPath,
        wrapperPath,
        status: "skipped",
        reason: "disabled",
      },
      statuslineLatest: await readStatuslineLatest(freshnessMs),
    };
  }

  if (!existsSync(settingsPath)) {
    return {
      skipped: false,
      claude: {
        settingsPath,
        wrapperPath,
        status: "skipped",
        reason: "settings-missing",
      },
      statuslineLatest: await readStatuslineLatest(freshnessMs),
    };
  }

  if (isClaudeStatuslineWrapperIsolatedFromSettings(settingsPath, wrapperPath)) {
    return {
      skipped: false,
      claude: {
        settingsPath,
        wrapperPath,
        status: "skipped",
        reason: "isolated-support-directory",
      },
      statuslineLatest: await readStatuslineLatest(freshnessMs),
    };
  }

  const command = await readClaudeStatuslineCommand(settingsPath);
  // A wrapper path in the command must be *ours*: a statusline left pointing at
  // another (possibly deleted) install's wrapper is not installed here. The
  // installer reclaims a dead one and leaves a live one alone.
  const commandWrapperPath = command ? claudeStatuslineCommandWrapperPath(command) : null;
  const alreadyInstalled = command
    ? (commandWrapperPath ? commandWrapperPath === wrapperPath : isOpenScoutClaudeStatuslineCommand(command, wrapperPath))
      && existsSync(wrapperPath)
      && await wrapperExecTargetExists(wrapperPath)
    : false;
  const claude = alreadyInstalled
    ? {
        settingsPath,
        wrapperPath,
        status: "already-installed" as const,
        command,
      }
    : reportFromInstall(await installClaudeStatuslineTool());

  return {
    skipped: false,
    claude,
    statuslineLatest: await readStatuslineLatest(freshnessMs),
  };
}

const HEAL_STALE_AFTER_MS = 10 * 60 * 1000;
const HEAL_MIN_INTERVAL_MS = 10 * 60 * 1000;
let lastHealAttemptAt = 0;

/**
 * Self-heal for quota capture. When Claude's statusline capture has gone
 * stale, re-run the (idempotent) bootstrap so a broken wiring — settings
 * pointed at a deleted wrapper, a wrapper whose scout binary moved — is
 * repaired without waiting for a restart. A healthy install is a no-op, and
 * attempts are throttled, so callers can invoke this on every quota read.
 * Returns null when nothing was attempted.
 */
export async function healProviderTelemetryIfStale(options: {
  env?: RuntimeEnv;
  staleAfterMs?: number;
  minIntervalMs?: number;
} = {}): Promise<ProviderTelemetryBootstrapReport | null> {
  // Under a test runner, only heal inside an isolated support directory; the
  // isolation guard in the bootstrap then keeps the real ~/.claude untouched.
  if (isTestRunnerProcess() && !process.env.OPENSCOUT_SUPPORT_DIRECTORY?.trim()) return null;
  const staleAfterMs = options.staleAfterMs ?? HEAL_STALE_AFTER_MS;
  const now = Date.now();
  if (now - lastHealAttemptAt < (options.minIntervalMs ?? HEAL_MIN_INTERVAL_MS)) return null;
  const latest = await readStatuslineLatest(staleAfterMs);
  if (latest.status === "fresh") return null;
  lastHealAttemptAt = now;
  return ensureProviderTelemetryBootstrap({
    ...(options.env ? { env: options.env } : {}),
    statuslineFreshnessMs: staleAfterMs,
  });
}

/** Test hook: forget the last heal attempt so throttling starts fresh. */
export function resetProviderTelemetryHealThrottle(): void {
  lastHealAttemptAt = 0;
}
