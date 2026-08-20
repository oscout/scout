import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_OPERATOR_NAME } from "@openscout/runtime/setup";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import {
  formatRelativeTime,
  formatTimeLabel,
  normalizeTimestamp,
  runOptionalCommand,
} from "./shell-utils.ts";

export type TmuxSession = {
  name: string;
  createdAt: number | null;
};

export type HelperStatus = {
  running: boolean;
  detail: string | null;
  heartbeatLabel: string | null;
};

export type ProjectGitActivity = {
  lastCodeChangeAt: number | null;
  lastCodeChangeLabel: string | null;
};

const PROJECT_GIT_ACTIVITY_CACHE_TTL_MS = 60_000;
const TMUX_SESSION_CACHE_TTL_MS = 2_000;

const projectGitActivityCache = new Map<string, { cachedAt: number; activity: ProjectGitActivity }>();
let tmuxSessionCache: { cachedAt: number; sessions: TmuxSession[] } | null = null;

export function readHelperStatus(): HelperStatus {
  const statusPath = resolveOpenScoutSupportPaths().desktopStatusPath;
  if (!existsSync(statusPath)) {
    return {
      running: false,
      detail: null,
      heartbeatLabel: null,
    };
  }

  try {
    const raw = JSON.parse(readFileSync(statusPath, "utf8")) as {
      state?: string;
      detail?: string;
      heartbeat?: number;
    };
    return {
      running: raw.state === "running",
      detail: typeof raw.detail === "string" ? raw.detail : null,
      heartbeatLabel: raw.heartbeat ? formatTimeLabel(raw.heartbeat) : null,
    };
  } catch {
    return {
      running: false,
      detail: "Helper status unreadable.",
      heartbeatLabel: null,
    };
  }
}

export function readTmuxSessions(): TmuxSession[] {
  if (tmuxSessionCache && Date.now() - tmuxSessionCache.cachedAt < TMUX_SESSION_CACHE_TTL_MS) {
    return tmuxSessionCache.sessions;
  }

  try {
    const stdout = readTmuxSessionOutput();
    const sessions = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, createdAtRaw] = line.split("\t");
        return {
          name,
          createdAt: createdAtRaw ? Number.parseInt(createdAtRaw, 10) : null,
        };
      });
    tmuxSessionCache = {
      cachedAt: Date.now(),
      sessions,
    };
    return sessions;
  } catch {
    return [];
  }
}

function readTmuxSessionOutput(): string {
  const output = runOptionalCommand("tmux", ["ls", "-F", "#{session_name}\t#{session_created}"]);
  if (output === null) {
    throw new Error("tmux unavailable");
  }
  return output;
}

function readDesktopSettingsRecord(): { operatorName?: string; profile?: { operatorName?: string } } {
  try {
    return JSON.parse(readFileSync(resolveOpenScoutSupportPaths().settingsPath, "utf8")) as {
      operatorName?: string;
      profile?: { operatorName?: string };
    };
  } catch {
    return {};
  }
}

export function resolveOperatorDisplayName(): string {
  const settings = readDesktopSettingsRecord();
  const candidate = settings.profile?.operatorName ?? settings.operatorName;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : DEFAULT_OPERATOR_NAME;
}

export function readProjectGitActivity(projectRoot: string | null | undefined): ProjectGitActivity {
  if (!projectRoot) {
    return {
      lastCodeChangeAt: null,
      lastCodeChangeLabel: null,
    };
  }

  const normalizedRoot = path.resolve(projectRoot);
  const cached = projectGitActivityCache.get(normalizedRoot);
  if (cached && Date.now() - cached.cachedAt < PROJECT_GIT_ACTIVITY_CACHE_TTL_MS) {
    return cached.activity;
  }

  const rawTimestamp = runOptionalCommand("git", ["-C", normalizedRoot, "log", "-1", "--format=%ct"]);
  const parsedTimestamp = Number.parseInt(rawTimestamp ?? "", 10);
  const lastCodeChangeAt = Number.isFinite(parsedTimestamp) && parsedTimestamp > 0
    ? normalizeTimestamp(parsedTimestamp)
    : null;
  const activity = {
    lastCodeChangeAt,
    lastCodeChangeLabel: lastCodeChangeAt ? formatRelativeTime(lastCodeChangeAt) : null,
  };
  projectGitActivityCache.set(normalizedRoot, {
    cachedAt: Date.now(),
    activity,
  });
  return activity;
}
