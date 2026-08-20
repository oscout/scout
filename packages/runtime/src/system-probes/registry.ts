export type ProbeBackend = "local" | "scoutd" | "local-fallback";
export type ProbeStatus = "empty" | "fresh" | "stale" | "failed";

export type ProbeError = {
  code: string;
  message: string;
  at: number;
  timedOut?: boolean;
};

export type ProbeSnapshot<T> = {
  id: string;
  key?: string;
  value: T | null;
  at: number | null;
  ageMs: number | null;
  stale: boolean;
  refreshing: boolean;
  status: ProbeStatus;
  error: ProbeError | null;
  consecutiveFailures: number;
  backend: ProbeBackend;
  fallbackSince?: number;
  fallbackReason?: string;
};

export type ProbeCtx = {
  probeId: string;
  key?: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxAgeMs?: number;
  startedAt: number;
};

export type ProbeBackendMetadata = {
  backend: ProbeBackend;
  fallbackSince?: number;
  fallbackReason?: string;
  generatedAt?: number;
};

export type ProbeRunOutput<T> = ProbeBackendMetadata & {
  value: T;
};

export type ProbeSpec<T> = {
  id: string;
  ttlMs: number;
  run: (ctx: ProbeCtx) => Promise<T | ProbeRunOutput<T>>;
  timeoutMs: number;
  maxStaleMs?: number;
};

export type ProbeFreshOptions = {
  maxAgeMs?: number;
};

export type ProbeMetrics = {
  id: string;
  key?: string;
  backend: ProbeBackend;
  runCount: number;
  failureCount: number;
  timeoutCount: number;
  staleServedCount: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  inFlight: boolean;
  fallbackSince?: number;
  fallbackReason?: string;
};

export type ProbeHandle<T> = {
  read: () => ProbeSnapshot<T>;
  fresh: (options?: ProbeFreshOptions) => Promise<ProbeSnapshot<T>>;
  snapshot: () => ProbeSnapshot<T>;
  invalidate: (reason?: string) => void;
  metrics: () => ProbeMetrics;
};

export type ProbeFamilySpec<K, T> = Omit<ProbeSpec<T>, "run"> & {
  normalizeKey: (key: K) => string;
  maxKeys: number;
  idleKeyTtlMs: number;
  maxConcurrentKeys: number;
  run: (key: string, ctx: ProbeCtx) => Promise<T | ProbeRunOutput<T>>;
};

export type ProbeFamilyMetrics = {
  id: string;
  keyCount: number;
  maxKeys: number;
  activeRuns: number;
  queuedRuns: number;
  keys: ProbeMetrics[];
};

export type ProbeFamilyHandle<K, T> = {
  for: (key: K) => ProbeHandle<T>;
  snapshot: (key: K) => ProbeSnapshot<T>;
  invalidate: (key: K, reason?: string) => void;
  metrics: () => ProbeFamilyMetrics;
  keys: () => string[];
};

export type RegisteredSystemProbe =
  | {
      kind: "probe";
      id: string;
      handle: ProbeHandle<unknown>;
    }
  | {
      kind: "family";
      id: string;
      family: ProbeFamilyHandle<unknown, unknown>;
    };

type ProbeState<T> = {
  value: T | null;
  at: number | null;
  error: ProbeError | null;
  consecutiveFailures: number;
  inFlight: Promise<void> | null;
  invalidated: boolean;
  invalidationReason: string | null;
  invalidationSerial: number;
  nextRetryAt: number;
  backend: ProbeBackend;
  fallbackSince: number | null;
  fallbackReason: string | null;
};

type MutableProbeMetrics = Omit<ProbeMetrics, "inFlight" | "consecutiveFailures">;

type ProbeInstanceOptions<T> = {
  spec: Pick<ProbeSpec<T>, "id" | "ttlMs" | "timeoutMs" | "maxStaleMs">;
  key?: string;
  run: (ctx: ProbeCtx) => Promise<T | ProbeRunOutput<T>>;
  scheduleRun?: <R>(task: () => Promise<R>) => Promise<R>;
};

const DEFAULT_MIN_MAX_STALE_MS = 2 * 60_000;
const PROBE_RUN_OUTPUT = Symbol("openscout.probeRunOutput");
const registeredProbes: RegisteredSystemProbe[] = [];

type InternalProbeRunOutput<T> = ProbeRunOutput<T> & {
  [PROBE_RUN_OUTPUT]: true;
};

export class ProbeBackendError extends Error {
  backend: ProbeBackend;
  fallbackSince?: number;
  fallbackReason?: string;
  code?: string;
  timedOut?: boolean;

  constructor(message: string, metadata: Omit<ProbeBackendMetadata, "generatedAt">, cause?: unknown) {
    super(message);
    this.name = "ProbeBackendError";
    this.backend = metadata.backend;
    this.fallbackSince = metadata.fallbackSince;
    this.fallbackReason = metadata.fallbackReason;
    const details = probeErrorDetails(cause);
    if (details.code) {
      this.code = details.code;
    }
    if (details.timedOut !== undefined) {
      this.timedOut = details.timedOut;
    }
  }
}

export function probeRunOutput<T>(value: T, metadata: ProbeBackendMetadata): ProbeRunOutput<T> {
  return {
    [PROBE_RUN_OUTPUT]: true,
    value,
    ...metadata,
  } as InternalProbeRunOutput<T>;
}

function isProbeRunOutput<T>(value: T | ProbeRunOutput<T>): value is InternalProbeRunOutput<T> {
  return typeof value === "object" && value !== null && (value as { [PROBE_RUN_OUTPUT]?: unknown })[PROBE_RUN_OUTPUT] === true;
}

function backendMetadataFromError(error: unknown): Omit<ProbeBackendMetadata, "generatedAt"> | null {
  if (error instanceof ProbeBackendError) {
    return {
      backend: error.backend,
      fallbackSince: error.fallbackSince,
      fallbackReason: error.fallbackReason,
    };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { backend?: unknown; fallbackSince?: unknown; fallbackReason?: unknown };
    if (record.backend === "local" || record.backend === "scoutd" || record.backend === "local-fallback") {
      return {
        backend: record.backend,
        fallbackSince: typeof record.fallbackSince === "number" ? record.fallbackSince : undefined,
        fallbackReason: typeof record.fallbackReason === "string" ? record.fallbackReason : undefined,
      };
    }
  }
  return null;
}

function probeErrorDetails(error: unknown): { code?: string; timedOut?: boolean } {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const record = error as { code?: unknown; timedOut?: unknown };
  const code = typeof record.code === "string" && record.code.trim()
    ? record.code.trim()
    : undefined;
  const timedOut = record.timedOut === true || code === "timeout"
    ? true
    : record.timedOut === false
      ? false
      : undefined;
  return { code, timedOut };
}

export function registeredSystemProbes(): RegisteredSystemProbe[] {
  return [...registeredProbes];
}

function assertProbeSpec(spec: Pick<ProbeSpec<unknown>, "id" | "ttlMs" | "timeoutMs" | "maxStaleMs">): void {
  if (!spec.id.trim()) {
    throw new Error("Probe id is required");
  }
  if (!Number.isFinite(spec.ttlMs) || spec.ttlMs <= 0) {
    throw new Error(`Probe ${spec.id} must declare a positive ttlMs`);
  }
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new Error(`Probe ${spec.id} must declare a positive timeoutMs`);
  }
  if (spec.maxStaleMs !== undefined && (!Number.isFinite(spec.maxStaleMs) || spec.maxStaleMs <= 0)) {
    throw new Error(`Probe ${spec.id} maxStaleMs must be positive when set`);
  }
}

function maxStaleMsFor(spec: Pick<ProbeSpec<unknown>, "ttlMs" | "maxStaleMs">): number {
  return spec.maxStaleMs ?? Math.max(DEFAULT_MIN_MAX_STALE_MS, spec.ttlMs * 10);
}

function failureBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  return Math.min(30_000, 1_000 * (2 ** Math.min(consecutiveFailures - 1, 5)));
}

function probeErrorFromUnknown(error: unknown, at: number, timedOut = false): ProbeError {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; name?: unknown; message?: unknown };
    const code = typeof record.code === "string" && record.code.trim()
      ? record.code.trim()
      : timedOut
        ? "timeout"
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : "error";
    const message = typeof record.message === "string" && record.message.trim()
      ? record.message
      : String(error);
    return { code, message, at, ...(timedOut ? { timedOut: true } : {}) };
  }
  return {
    code: timedOut ? "timeout" : "error",
    message: String(error),
    at,
    ...(timedOut ? { timedOut: true } : {}),
  };
}

function timeoutError(probeId: string, timeoutMs: number): ProbeError {
  return {
    code: "timeout",
    message: `Probe ${probeId} timed out after ${timeoutMs}ms`,
    at: Date.now(),
    timedOut: true,
  };
}

function staleTooLongError(probeId: string, ageMs: number, maxStaleMs: number): ProbeError {
  return {
    code: "max_stale_exceeded",
    message: `Probe ${probeId} last good snapshot is ${ageMs}ms old, exceeding maxStaleMs ${maxStaleMs}`,
    at: Date.now(),
  };
}

function isFreshEnough<T>(state: ProbeState<T>, maxAgeMs: number): boolean {
  if (state.at === null || state.invalidated) {
    return false;
  }
  return Date.now() - state.at <= maxAgeMs;
}

function logBackendTransition(input: {
  id: string;
  key?: string;
  from: ProbeBackend;
  to: ProbeBackend;
  reason?: string | null;
}): void {
  if (input.from === input.to) {
    return;
  }
  const keySuffix = input.key === undefined ? "" : ` key=${JSON.stringify(input.key)}`;
  const reasonSuffix = input.reason ? ` (${input.reason})` : "";
  console.warn(`[openscout] system probe ${input.id}${keySuffix} backend ${input.from} -> ${input.to}${reasonSuffix}`);
}

class ProbeInstance<T> implements ProbeHandle<T> {
  private readonly spec: Pick<ProbeSpec<T>, "id" | "ttlMs" | "timeoutMs" | "maxStaleMs">;
  private readonly key: string | undefined;
  private readonly runProbe: (ctx: ProbeCtx) => Promise<T | ProbeRunOutput<T>>;
  private readonly scheduleRun: <R>(task: () => Promise<R>) => Promise<R>;
  private readonly state: ProbeState<T> = {
    value: null,
    at: null,
    error: null,
    consecutiveFailures: 0,
    inFlight: null,
    invalidated: false,
    invalidationReason: null,
    invalidationSerial: 0,
    nextRetryAt: 0,
    backend: "local",
    fallbackSince: null,
    fallbackReason: null,
  };
  private readonly metricState: MutableProbeMetrics;
  lastAccessAt = Date.now();

  constructor(options: ProbeInstanceOptions<T>) {
    this.spec = options.spec;
    this.key = options.key;
    this.runProbe = options.run;
    this.scheduleRun = options.scheduleRun ?? ((task) => task());
    this.metricState = {
      id: options.spec.id,
      ...(options.key !== undefined ? { key: options.key } : {}),
      backend: "local",
      runCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      staleServedCount: 0,
      lastRunAt: null,
      lastDurationMs: null,
      lastSuccessAt: null,
    };
  }

  read(): ProbeSnapshot<T> {
    this.touch();
    if (this.shouldRefreshForRead(Date.now())) {
      void this.ensureRefresh(false, this.spec.ttlMs);
    }
    const snap = this.snapshot();
    if (snap.status === "stale" || (snap.status === "failed" && snap.at !== null)) {
      this.metricState.staleServedCount += 1;
    }
    return snap;
  }

  async fresh(options: ProbeFreshOptions = {}): Promise<ProbeSnapshot<T>> {
    this.touch();
    const maxAgeMs = options.maxAgeMs ?? this.spec.ttlMs;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (isFreshEnough(this.state, maxAgeMs)) {
        return this.snapshot();
      }
      await this.ensureRefresh(true, maxAgeMs);
      // If a side effect invalidated the probe while the awaited run was already
      // in flight, that run may have observed pre-side-effect state. Loop once
      // more so fresh() blocks on a post-invalidation run.
      if (!this.state.invalidated) {
        return this.snapshot();
      }
    }
    return this.snapshot();
  }

  snapshot(): ProbeSnapshot<T> {
    const now = Date.now();
    const ageMs = this.state.at === null ? null : Math.max(0, now - this.state.at);
    const maxStaleMs = maxStaleMsFor(this.spec);
    const exceededMaxStale = ageMs !== null && ageMs > maxStaleMs;
    const fresh = ageMs !== null && !this.state.invalidated && ageMs <= this.spec.ttlMs;
    const status: ProbeStatus = this.state.at === null
      ? this.state.error
        ? "failed"
        : "empty"
      : exceededMaxStale
        ? "failed"
        : fresh
          ? "fresh"
          : "stale";
    const error = exceededMaxStale
      ? this.state.error ?? staleTooLongError(this.spec.id, ageMs ?? 0, maxStaleMs)
      : this.state.error;

    return {
      id: this.spec.id,
      ...(this.key !== undefined ? { key: this.key } : {}),
      value: status === "failed" && exceededMaxStale ? null : this.state.value,
      at: this.state.at,
      ageMs,
      stale: status === "stale" || (status === "failed" && this.state.at !== null),
      refreshing: this.state.inFlight !== null,
      status,
      error,
      consecutiveFailures: this.state.consecutiveFailures,
      backend: this.state.backend,
      ...(this.state.fallbackSince !== null ? { fallbackSince: this.state.fallbackSince } : {}),
      ...(this.state.fallbackReason !== null ? { fallbackReason: this.state.fallbackReason } : {}),
    };
  }

  invalidate(reason?: string): void {
    this.touch();
    this.state.invalidated = true;
    this.state.invalidationReason = reason ?? null;
    this.state.invalidationSerial += 1;
    this.state.nextRetryAt = 0;
  }

  metrics(): ProbeMetrics {
    return {
      ...this.metricState,
      consecutiveFailures: this.state.consecutiveFailures,
      inFlight: this.state.inFlight !== null,
      ...(this.state.fallbackSince !== null ? { fallbackSince: this.state.fallbackSince } : {}),
      ...(this.state.fallbackReason !== null ? { fallbackReason: this.state.fallbackReason } : {}),
    };
  }

  isRefreshing(): boolean {
    return this.state.inFlight !== null;
  }

  private touch(): void {
    this.lastAccessAt = Date.now();
  }

  private shouldRefreshForRead(now: number): boolean {
    if (this.state.inFlight !== null) {
      return false;
    }
    if (this.state.nextRetryAt > now) {
      return false;
    }
    if (this.state.at === null) {
      return true;
    }
    if (this.state.invalidated) {
      return true;
    }
    return now - this.state.at > this.spec.ttlMs;
  }

  private ensureRefresh(force: boolean, maxAgeMs: number): Promise<void> {
    if (this.state.inFlight) {
      return this.state.inFlight;
    }
    const now = Date.now();
    if (!force && this.state.nextRetryAt > now) {
      return Promise.resolve();
    }
    const inFlight = this.scheduleRun(() => this.executeRun(maxAgeMs))
      .finally(() => {
        if (this.state.inFlight === inFlight) {
          this.state.inFlight = null;
        }
      });
    this.state.inFlight = inFlight;
    return inFlight;
  }

  private async executeRun(maxAgeMs: number): Promise<void> {
    const startedAt = Date.now();
    const previousBackend = this.state.backend;
    // Used to detect invalidate() calls that happen while this run is in flight.
    // Such runs must not clear the invalidation they did not observe.
    const invalidationSerialAtStart = this.state.invalidationSerial;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    this.metricState.runCount += 1;
    this.metricState.lastRunAt = startedAt;

    const ctx: ProbeCtx = {
      probeId: this.spec.id,
      ...(this.key !== undefined ? { key: this.key } : {}),
      signal: controller.signal,
      timeoutMs: this.spec.timeoutMs,
      maxAgeMs,
      startedAt,
    };

    const timeoutProbeError = timeoutError(this.spec.id, this.spec.timeoutMs);
    const runPromise = this.runProbe(ctx);
    runPromise.catch(() => undefined);

    try {
      const result = await new Promise<T | ProbeRunOutput<T>>((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(timeoutProbeError);
          reject(timeoutProbeError);
        }, this.spec.timeoutMs);
        runPromise.then(resolve, reject);
      });
      const output: ProbeRunOutput<T> = isProbeRunOutput<T>(result)
        ? result
        : probeRunOutput(result as T, { backend: "local" });
      this.state.value = output.value;
      this.state.at = output.generatedAt ?? Date.now();
      this.state.error = null;
      this.state.consecutiveFailures = 0;
      if (this.state.invalidationSerial === invalidationSerialAtStart) {
        this.state.invalidated = false;
        this.state.invalidationReason = null;
      }
      this.state.nextRetryAt = 0;
      this.state.backend = output.backend;
      this.state.fallbackSince = output.fallbackSince ?? null;
      this.state.fallbackReason = output.fallbackReason ?? null;
      this.metricState.backend = output.backend;
      this.metricState.lastSuccessAt = this.state.at;
      logBackendTransition({
        id: this.spec.id,
        key: this.key,
        from: previousBackend,
        to: output.backend,
        reason: output.fallbackReason,
      });
    } catch (error) {
      const timedOut = error === timeoutProbeError
        || (typeof error === "object" && error !== null && (
          (error as { code?: unknown }).code === "timeout"
          || (error as { timedOut?: unknown }).timedOut === true
        ));
      const at = Date.now();
      this.state.error = error === timeoutProbeError
        ? timeoutProbeError
        : probeErrorFromUnknown(error, at, timedOut);
      this.state.consecutiveFailures += 1;
      this.state.nextRetryAt = at + failureBackoffMs(this.state.consecutiveFailures);
      const backendMetadata = backendMetadataFromError(error);
      if (backendMetadata) {
        this.state.backend = backendMetadata.backend;
        this.state.fallbackSince = backendMetadata.fallbackSince ?? null;
        this.state.fallbackReason = backendMetadata.fallbackReason ?? null;
        this.metricState.backend = backendMetadata.backend;
        logBackendTransition({
          id: this.spec.id,
          key: this.key,
          from: previousBackend,
          to: backendMetadata.backend,
          reason: backendMetadata.fallbackReason,
        });
      }
      this.metricState.failureCount += 1;
      if (this.state.error.timedOut || this.state.error.code === "timeout") {
        this.metricState.timeoutCount += 1;
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.metricState.lastDurationMs = Date.now() - startedAt;
    }
  }
}

class FamilyLimiter {
  active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  queued(): number {
    return this.queue.length;
  }

  async run<R>(task: () => Promise<R>): Promise<R> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

class ProbeFamily<K, T> implements ProbeFamilyHandle<K, T> {
  private readonly entries = new Map<string, ProbeInstance<T>>();
  private readonly limiter: FamilyLimiter;

  constructor(private readonly spec: ProbeFamilySpec<K, T>) {
    assertProbeSpec(spec);
    if (!Number.isInteger(spec.maxKeys) || spec.maxKeys <= 0) {
      throw new Error(`Probe family ${spec.id} must declare a positive maxKeys`);
    }
    if (!Number.isFinite(spec.idleKeyTtlMs) || spec.idleKeyTtlMs <= 0) {
      throw new Error(`Probe family ${spec.id} must declare a positive idleKeyTtlMs`);
    }
    if (!Number.isInteger(spec.maxConcurrentKeys) || spec.maxConcurrentKeys <= 0) {
      throw new Error(`Probe family ${spec.id} must declare a positive maxConcurrentKeys`);
    }
    this.limiter = new FamilyLimiter(spec.maxConcurrentKeys);
  }

  for(rawKey: K): ProbeHandle<T> {
    const key = this.normalize(rawKey);
    this.cleanupIdle(Date.now());
    let entry = this.entries.get(key);
    if (!entry) {
      entry = new ProbeInstance<T>({
        spec: this.spec,
        key,
        run: (ctx) => this.spec.run(key, ctx),
        scheduleRun: (task) => this.limiter.run(task),
      });
      this.entries.set(key, entry);
    }
    entry.lastAccessAt = Date.now();
    this.evictLruIfNeeded();
    return entry;
  }

  snapshot(key: K): ProbeSnapshot<T> {
    return this.for(key).snapshot();
  }

  invalidate(key: K, reason?: string): void {
    this.for(key).invalidate(reason);
  }

  metrics(): ProbeFamilyMetrics {
    this.cleanupIdle(Date.now());
    return {
      id: this.spec.id,
      keyCount: this.entries.size,
      maxKeys: this.spec.maxKeys,
      activeRuns: this.limiter.active,
      queuedRuns: this.limiter.queued(),
      keys: Array.from(this.entries.values(), (entry) => entry.metrics()),
    };
  }

  keys(): string[] {
    this.cleanupIdle(Date.now());
    return Array.from(this.entries.keys());
  }

  private normalize(rawKey: K): string {
    const key = this.spec.normalizeKey(rawKey).trim();
    if (!key) {
      throw new Error(`Probe family ${this.spec.id} normalized an empty key`);
    }
    return key;
  }

  private cleanupIdle(now: number): void {
    for (const [key, entry] of this.entries) {
      if (!entry.isRefreshing() && now - entry.lastAccessAt > this.spec.idleKeyTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictLruIfNeeded(): void {
    while (this.entries.size > this.spec.maxKeys) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.isRefreshing()) {
          continue;
        }
        if (entry.lastAccessAt < oldestAccess) {
          oldestAccess = entry.lastAccessAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

export function defineProbe<T>(spec: ProbeSpec<T>): ProbeHandle<T> {
  assertProbeSpec(spec);
  const handle = new ProbeInstance<T>({
    spec,
    run: spec.run,
  });
  registeredProbes.push({
    kind: "probe",
    id: spec.id,
    handle: handle as ProbeHandle<unknown>,
  });
  return handle;
}

export function defineProbeFamily<K, T>(spec: ProbeFamilySpec<K, T>): ProbeFamilyHandle<K, T> {
  const family = new ProbeFamily<K, T>(spec);
  registeredProbes.push({
    kind: "family",
    id: spec.id,
    family: family as unknown as ProbeFamilyHandle<unknown, unknown>,
  });
  return family;
}
