import { join } from "node:path";

import { OPENSCOUT_PORTS } from "../local-config.js";
import { resolveOpenScoutSupportPaths } from "../support-paths.js";

/**
 * Where a newly enabled publisher starts reading the canonical journal.
 *
 * `now` is the default on purpose: turning the sidecar on must not replay a
 * machine's entire private message history into a new stream. `beginning` is
 * an explicit operator choice.
 */
export type JetStreamStartPosition = "now" | "beginning";

export type JetStreamRuntimeConfig = {
  enabled: boolean;
  /** True when this process owns the sidecar lifecycle. */
  manageServer: boolean;
  host: string;
  port: number;
  monitorPort: number;
  serverBinary: string;
  /** `nats-server -sd` store directory. Persistent and known. */
  storeDirectory: string;
  /** Publisher progress file. Sits beside the store, never inside it. */
  progressPath: string;
  logPath: string;
  pidPath: string;
  streamName: string;
  subjectPrefix: string;
  startPosition: JetStreamStartPosition;
  /**
   * JetStream's `Nats-Msg-Id` dedupe window. Must stay comfortably wider than
   * `checkpointIntervalMs`: a catch-up pass deliberately republishes everything
   * since the last committed barrier, and this window is what collapses those
   * republishes back into one stream message.
   */
  duplicateWindowMs: number;
  maxAgeMs: number;
  maxBytes: number;
  publishTimeoutMs: number;
  publishMaxAttempts: number;
  checkpointIntervalMs: number;
  /** Bounded in-memory live queue before the publisher falls back to scanning. */
  maxQueuedEvents: number;
  connectTimeoutMs: number;
  maxReconnectAttempts: number;
  reconnectTimeWaitMs: number;
  readyTimeoutMs: number;
};

export const JETSTREAM_SUBJECT_PREFIX = "scout.v1";
export const JETSTREAM_DEFAULT_STREAM = "SCOUT_EVENTS";
/** Stamped on streams this runtime created, so validation can tell ours apart. */
export const JETSTREAM_STREAM_OWNER_TAG = "openscout:scout-events:v1";

// IPv6 loopback is deliberately out of scope for this slice: `--addr ::1` and
// `nats://[::1]:port` need bracket handling in three places, and 127.0.0.1 is
// what every local consumer here already uses.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

function envInt(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

/**
 * Refuse anything but loopback.
 *
 * The sidecar carries no authentication in this slice, so a non-loopback bind
 * would publish Scout coordination facts to the LAN. That is a deliberate
 * hard failure rather than a silent downgrade.
 */
export function assertLoopbackJetStreamHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(
      `OpenScout JetStream refuses a non-loopback bind address (${host}). `
        + "This slice ships no NATS authentication and no IPv6 bracket handling; "
        + "remove OPENSCOUT_JETSTREAM_HOST or set it to 127.0.0.1.",
    );
  }
  return normalized === "localhost" ? "127.0.0.1" : normalized;
}

export function resolveJetStreamConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<JetStreamRuntimeConfig> = {},
): JetStreamRuntimeConfig {
  const support = resolveOpenScoutSupportPaths();
  const root = env.OPENSCOUT_JETSTREAM_HOME?.trim() || join(support.supportDirectory, "jetstream");
  const host = assertLoopbackJetStreamHost(env.OPENSCOUT_JETSTREAM_HOST?.trim() || "127.0.0.1");
  const startRaw = env.OPENSCOUT_JETSTREAM_START?.trim().toLowerCase();

  const resolved: JetStreamRuntimeConfig = {
    enabled: envFlag(env, "OPENSCOUT_JETSTREAM_ENABLED") ?? false,
    manageServer: envFlag(env, "OPENSCOUT_JETSTREAM_MANAGE_SERVER") ?? true,
    host,
    port: envInt(env, "OPENSCOUT_JETSTREAM_PORT", 1, 65535) ?? OPENSCOUT_PORTS.jetstream,
    monitorPort: envInt(env, "OPENSCOUT_JETSTREAM_MONITOR_PORT", 1, 65535)
      ?? OPENSCOUT_PORTS.jetstreamMonitor,
    serverBinary: env.OPENSCOUT_JETSTREAM_BINARY?.trim() || "nats-server",
    storeDirectory: join(root, "store"),
    progressPath: join(root, "publisher-progress.json"),
    logPath: join(root, "nats-server.log"),
    pidPath: join(root, "nats-server.pid"),
    streamName: env.OPENSCOUT_JETSTREAM_STREAM?.trim() || JETSTREAM_DEFAULT_STREAM,
    subjectPrefix: JETSTREAM_SUBJECT_PREFIX,
    startPosition: startRaw === "beginning" ? "beginning" : "now",
    duplicateWindowMs: envInt(env, "OPENSCOUT_JETSTREAM_DUPLICATE_WINDOW_MS", 1_000, 3_600_000)
      ?? 600_000,
    maxAgeMs: envInt(env, "OPENSCOUT_JETSTREAM_MAX_AGE_MS", 60_000, 30 * 24 * 3_600_000)
      ?? 7 * 24 * 3_600_000,
    maxBytes: envInt(env, "OPENSCOUT_JETSTREAM_MAX_BYTES", 1_048_576, 64 * 1_073_741_824)
      ?? 512 * 1_048_576,
    publishTimeoutMs: 5_000,
    publishMaxAttempts: 4,
    checkpointIntervalMs: envInt(env, "OPENSCOUT_JETSTREAM_CHECKPOINT_MS", 1_000, 600_000)
      ?? 30_000,
    maxQueuedEvents: 2_000,
    connectTimeoutMs: 5_000,
    maxReconnectAttempts: 30,
    reconnectTimeWaitMs: 1_000,
    readyTimeoutMs: 15_000,
    ...overrides,
  };

  if (resolved.duplicateWindowMs <= resolved.checkpointIntervalMs) {
    throw new Error(
      "OpenScout JetStream duplicate window must exceed the checkpoint interval "
        + `(window=${resolved.duplicateWindowMs}ms, checkpoint=${resolved.checkpointIntervalMs}ms). `
        + "A narrower window would turn every catch-up pass into duplicate stream messages.",
    );
  }
  return { ...resolved, host: assertLoopbackJetStreamHost(resolved.host) };
}

export function jetStreamServerUrl(config: Pick<JetStreamRuntimeConfig, "host" | "port">): string {
  return `nats://${config.host}:${config.port}`;
}

export function jetStreamMonitorUrl(
  config: Pick<JetStreamRuntimeConfig, "host" | "monitorPort">,
): string {
  return `http://${config.host}:${config.monitorPort}`;
}
