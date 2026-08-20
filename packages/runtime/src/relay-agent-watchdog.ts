import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RuntimeEnv } from "./portable-types.js";
import { assertTestIsolatedUserData, resolveOpenScoutSupportPaths } from "./support-paths.js";

/**
 * Relay-agent owner-death watchdog.
 *
 * Relay agents run inside detached tmux sessions whose server is parented to
 * launchd, so nothing in the process tree ties a relay's lifetime to the
 * runtime that spawned it. The broker daemon therefore maintains a heartbeat
 * file, and every relay launch script embeds a watchdog loop that kills the
 * harness process (and its tmux session) once the heartbeat goes stale. A
 * relay must not outlive the runtime it serves: if the broker is gone for
 * longer than the grace window, nothing can route work to the relay anyway.
 *
 * A broker restart inside the grace window keeps the heartbeat fresh enough
 * that live relays are adopted rather than churned.
 */

export const BROKER_RUNTIME_HEARTBEAT_FILENAME = "broker-heartbeat.json";

export const DEFAULT_RELAY_AGENT_ORPHAN_GRACE_MS = 15 * 60_000;
const MIN_RELAY_AGENT_ORPHAN_GRACE_MS = 60_000;
const DEFAULT_WATCHDOG_POLL_SECONDS = 30;

export function brokerRuntimeHeartbeatPath(): string {
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, BROKER_RUNTIME_HEARTBEAT_FILENAME);
}

/**
 * Stamp the runtime heartbeat. Watchdogs only read the file's mtime; the
 * payload exists so a human inspecting the file can see which pid owns it.
 */
export function touchBrokerRuntimeHeartbeat(): string {
  assertTestIsolatedUserData("write the broker runtime heartbeat", "OPENSCOUT_SUPPORT_DIRECTORY");
  const path = brokerRuntimeHeartbeatPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, updatedAtMs: Date.now() })}\n`);
  return path;
}

export function resolveRelayAgentOrphanGraceMs(env: RuntimeEnv = process.env): number {
  const raw = env.OPENSCOUT_RELAY_AGENT_ORPHAN_GRACE_MS?.trim();
  if (!raw) {
    return DEFAULT_RELAY_AGENT_ORPHAN_GRACE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RELAY_AGENT_ORPHAN_GRACE_MS;
  }
  // Zero or negative disables the watchdog entirely.
  if (parsed <= 0) {
    return 0;
  }
  return Math.max(MIN_RELAY_AGENT_ORPHAN_GRACE_MS, parsed);
}

export type RelayAgentWatchdogOptions = {
  sessionName: string;
  heartbeatPath?: string;
  graceMs?: number;
  pollSeconds?: number;
};

/**
 * Shell directives that install the watchdog inside a relay launch script.
 *
 * The launch script must `exec` the harness as its final command so that `$$`
 * — captured here, before the exec — is the harness pid itself. That makes the
 * watchdog's liveness probe and kill target exact: the pid cannot be recycled
 * while the harness is alive, and the watchdog exits with the harness.
 *
 * Runs under `set -uo pipefail` in a non-interactive bash. Both mtime
 * spellings are attempted — GNU (`stat -c %Y`) first, then macOS/BSD
 * (`stat -f %m`) — and validated numerically, because on GNU `stat -f` is
 * *filesystem* status and succeeds with non-numeric output (so mere
 * command-success cannot pick the right spelling). A missing or unreadable
 * heartbeat counts from the relay's own launch time, so a runtime that never
 * heartbeats again still reaps its relays after the grace window.
 */
export function buildRelayAgentWatchdogDirectives(options: RelayAgentWatchdogOptions): string[] {
  const graceMs = options.graceMs ?? DEFAULT_RELAY_AGENT_ORPHAN_GRACE_MS;
  if (graceMs <= 0) {
    return [];
  }
  const graceSeconds = Math.max(1, Math.round(graceMs / 1000));
  const pollSeconds = Math.max(1, Math.round(options.pollSeconds ?? DEFAULT_WATCHDOG_POLL_SECONDS));
  const heartbeatPath = options.heartbeatPath ?? brokerRuntimeHeartbeatPath();

  return [
    "# Watchdog: a relay agent must not outlive the OpenScout runtime it serves.",
    `OPENSCOUT_RELAY_HEARTBEAT=${JSON.stringify(heartbeatPath)}`,
    'OPENSCOUT_RELAY_PID="$$"',
    "(",
    '  launched_at="$(date +%s)"',
    '  while kill -0 "$OPENSCOUT_RELAY_PID" 2>/dev/null; do',
    `    sleep ${pollSeconds}`,
    '    now="$(date +%s)"',
    '    beat="$(stat -c %Y "$OPENSCOUT_RELAY_HEARTBEAT" 2>/dev/null || true)"',
    "    case \"$beat\" in ''|*[!0-9]*) beat=\"$(stat -f %m \"$OPENSCOUT_RELAY_HEARTBEAT\" 2>/dev/null || true)\";; esac",
    "    case \"$beat\" in ''|*[!0-9]*) beat=\"$launched_at\";; esac",
    `    if [ "$((now - beat))" -lt ${graceSeconds} ]; then`,
    "      continue",
    "    fi",
    '    if ! kill -0 "$OPENSCOUT_RELAY_PID" 2>/dev/null; then',
    "      break",
    "    fi",
    '    kill -TERM "$OPENSCOUT_RELAY_PID" 2>/dev/null || true',
    "    sleep 5",
    '    kill -KILL "$OPENSCOUT_RELAY_PID" 2>/dev/null || true',
    '    if [ -n "${TMUX:-}" ]; then',
    `      tmux kill-session -t ${JSON.stringify(options.sessionName)} 2>/dev/null || true`,
    "    fi",
    "    exit 0",
    "  done",
    ") >/dev/null 2>&1 &",
  ];
}
