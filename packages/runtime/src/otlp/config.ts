export const OTLP_HOST = "127.0.0.1";
export const DEFAULT_OTLP_PORT = 43160;
export const otlpPaths = {
  traces: "/v1/traces", logs: "/v1/logs", metrics: "/v1/metrics",
  health: "/health", observations: "/observations",
  inspector: "/", favicon: "/favicon.ico",
} as const;
export const otlpDefaults = {
  maxWireBytes: 1024 * 1024, maxDecodedBytes: 4 * 1024 * 1024,
  maxConcurrentRequests: 4, requestTimeoutMs: 10_000, maxDepth: 32,
  maxItems: 4096, maxAttributes: 64, maxStringLength: 256,
  maxQueueItems: 4096, maxQueueBytes: 8 * 1024 * 1024, maxResourceQueueItems: 512,
  flushIntervalMs: 300, flushBatchSize: 128, ttlMs: 6 * 60 * 60 * 1000,
  maxResourceRows: 2000, maxRows: 20_000, maxStoreBytes: 32 * 1024 * 1024,
  maxDatabaseBytes: 64 * 1024 * 1024,
} as const;
export type OtlpLimits = { [Key in keyof typeof otlpDefaults]: number };

export function resolveOtlpLimits(overrides: Partial<OtlpLimits> = {}): OtlpLimits {
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(otlpDefaults, key) || !Number.isSafeInteger(value) || value! <= 0) {
      throw new Error("Invalid OTLP limit");
    }
  }
  const limits = { ...otlpDefaults, ...overrides };
  if (limits.maxDepth > 64 || limits.maxDatabaseBytes < 4096) throw new Error("Invalid OTLP limit");
  return limits;
}

export function resolveOtlpPort(value: string | number | undefined, allowEphemeral = false): number {
  const port = value === undefined ? DEFAULT_OTLP_PORT : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < (allowEphemeral ? 0 : 1) || port > 65535) {
    throw new Error("Invalid OTLP port");
  }
  return port;
}

export function otlpBaseUrl(port: number): string {
  return `http://${OTLP_HOST}:${port}`;
}
