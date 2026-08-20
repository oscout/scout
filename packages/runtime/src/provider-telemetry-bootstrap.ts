import type { RuntimeEnv } from "./portable-types.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
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
    reason?: "settings-missing" | "disabled";
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

  const command = await readClaudeStatuslineCommand(settingsPath);
  const alreadyInstalled = command
    ? isOpenScoutClaudeStatuslineCommand(command, wrapperPath) && existsSync(wrapperPath)
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
