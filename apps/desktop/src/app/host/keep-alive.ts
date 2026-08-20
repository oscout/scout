export type ScoutKeepAliveStrength = "normal" | "strong" | "max";

export type ScoutKeepAliveSource = "manual" | "heuristic" | "session_policy";

export type ScoutKeepAliveOptions = {
  preventIdleSystemSleep: boolean;
  preventIdleDisplaySleep: boolean;
  allowClosedDisplay: boolean;
  enablePowerProtectFallback: boolean;
  autoExtendWhileWorkIsActive: boolean;
  autoDisableWhenIdle: boolean;
};

export type ScoutKeepAliveLease = {
  id: string;
  source: ScoutKeepAliveSource;
  requester: "ios" | "desktop" | "broker";
  reason: string;
  strength: ScoutKeepAliveStrength;
  startedAt: number;
  expiresAt: number | null;
  options: ScoutKeepAliveOptions;
};

export type ScoutKeepAliveState = {
  active: boolean;
  strength: ScoutKeepAliveStrength | null;
  source: ScoutKeepAliveSource | null;
  reason: string | null;
  startedAt: number | null;
  expiresAt: number | null;
  leaseCount: number;
  options: ScoutKeepAliveOptions;
};

export type AcquireScoutKeepAliveLeaseInput = {
  source: ScoutKeepAliveSource;
  requester: "ios" | "desktop" | "broker";
  reason: string;
  strength: ScoutKeepAliveStrength;
  durationMinutes?: number | null;
  options?: Partial<ScoutKeepAliveOptions>;
};

export type ReleaseScoutKeepAliveLeaseInput = {
  leaseId: string;
};

export type ScoutKeepAliveHost = {
  startPowerSaveBlocker: (type: "prevent-app-suspension" | "prevent-display-sleep") => number;
  stopPowerSaveBlocker: (id: number) => void;
};

const DEFAULT_KEEP_ALIVE_OPTIONS: Record<ScoutKeepAliveStrength, ScoutKeepAliveOptions> = {
  normal: {
    preventIdleSystemSleep: true,
    preventIdleDisplaySleep: false,
    allowClosedDisplay: false,
    enablePowerProtectFallback: false,
    autoExtendWhileWorkIsActive: true,
    autoDisableWhenIdle: true,
  },
  strong: {
    preventIdleSystemSleep: true,
    preventIdleDisplaySleep: false,
    allowClosedDisplay: false,
    enablePowerProtectFallback: false,
    autoExtendWhileWorkIsActive: true,
    autoDisableWhenIdle: true,
  },
  max: {
    preventIdleSystemSleep: true,
    preventIdleDisplaySleep: false,
    allowClosedDisplay: true,
    enablePowerProtectFallback: false,
    autoExtendWhileWorkIsActive: true,
    autoDisableWhenIdle: false,
  },
};

function createLeaseId() {
  return `keepalive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return Date.now();
}

function strongestStrength(a: ScoutKeepAliveStrength, b: ScoutKeepAliveStrength) {
  const order: ScoutKeepAliveStrength[] = ["normal", "strong", "max"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function mergedOptions(values: ScoutKeepAliveOptions[]): ScoutKeepAliveOptions {
  return values.reduce<ScoutKeepAliveOptions>((acc, value) => ({
    preventIdleSystemSleep: acc.preventIdleSystemSleep || value.preventIdleSystemSleep,
    preventIdleDisplaySleep: acc.preventIdleDisplaySleep || value.preventIdleDisplaySleep,
    allowClosedDisplay: acc.allowClosedDisplay || value.allowClosedDisplay,
    enablePowerProtectFallback: acc.enablePowerProtectFallback || value.enablePowerProtectFallback,
    autoExtendWhileWorkIsActive: acc.autoExtendWhileWorkIsActive || value.autoExtendWhileWorkIsActive,
    autoDisableWhenIdle: acc.autoDisableWhenIdle && value.autoDisableWhenIdle,
  }), {
    preventIdleSystemSleep: false,
    preventIdleDisplaySleep: false,
    allowClosedDisplay: false,
    enablePowerProtectFallback: false,
    autoExtendWhileWorkIsActive: false,
    autoDisableWhenIdle: true,
  });
}

class ScoutKeepAliveManager {
  private host: ScoutKeepAliveHost | null = null;
  private leases = new Map<string, ScoutKeepAliveLease>();
  private expirationTimer: ReturnType<typeof setTimeout> | null = null;
  private blockerId: number | null = null;
  private blockerType: "prevent-app-suspension" | "prevent-display-sleep" | null = null;

  configureHost(host: ScoutKeepAliveHost | null) {
    this.host = host;
    this.syncBlocker()
  }

  getState(): ScoutKeepAliveState {
    this.pruneExpiredLeases()
    const activeLeases = [...this.leases.values()].sort((lhs, rhs) => {
      const lhsExpiresAt = lhs.expiresAt ?? Number.MAX_SAFE_INTEGER
      const rhsExpiresAt = rhs.expiresAt ?? Number.MAX_SAFE_INTEGER
      return lhs.startedAt - rhs.startedAt || lhsExpiresAt - rhsExpiresAt
    })

    if (activeLeases.length === 0) {
      return {
        active: false,
        strength: null,
        source: null,
        reason: null,
        startedAt: null,
        expiresAt: null,
        leaseCount: 0,
        options: DEFAULT_KEEP_ALIVE_OPTIONS.normal,
      }
    }

    const options = mergedOptions(activeLeases.map((lease) => lease.options))
    const strongest = activeLeases.reduce<ScoutKeepAliveStrength>(
      (current, lease) => strongestStrength(current, lease.strength),
      activeLeases[0]!.strength,
    )
    const latest = activeLeases[activeLeases.length - 1]!

    return {
      active: true,
      strength: strongest,
      source: latest.source,
      reason: latest.reason,
      startedAt: activeLeases[0]!.startedAt,
      expiresAt: activeLeases.reduce<number | null>((current, lease) => {
        if (lease.expiresAt == null) return null
        if (current == null) return lease.expiresAt
        return Math.max(current, lease.expiresAt)
      }, null),
      leaseCount: activeLeases.length,
      options,
    }
  }

  acquire(input: AcquireScoutKeepAliveLeaseInput): ScoutKeepAliveLease {
    this.pruneExpiredLeases()
    const startedAt = now()
    const durationMinutes = typeof input.durationMinutes === "number" && input.durationMinutes > 0
      ? Math.floor(input.durationMinutes)
      : null
    const strengthDefaults = DEFAULT_KEEP_ALIVE_OPTIONS[input.strength]
    const lease: ScoutKeepAliveLease = {
      id: createLeaseId(),
      source: input.source,
      requester: input.requester,
      reason: input.reason.trim() || "Keep alive requested",
      strength: input.strength,
      startedAt,
      expiresAt: durationMinutes == null ? null : startedAt + durationMinutes * 60_000,
      options: {
        ...strengthDefaults,
        ...(input.options ?? {}),
      },
    }

    this.leases.set(lease.id, lease)
    this.rescheduleExpirationTimer()
    this.syncBlocker()
    return lease
  }

  release(leaseId: string): boolean {
    const removed = this.leases.delete(leaseId)
    if (!removed) {
      return false
    }
    this.rescheduleExpirationTimer()
    this.syncBlocker()
    return true
  }

  shutdown() {
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer)
      this.expirationTimer = null
    }
    if (this.blockerId != null && this.host) {
      this.host.stopPowerSaveBlocker(this.blockerId)
    }
    this.blockerId = null
    this.blockerType = null
    this.leases.clear()
  }

  private pruneExpiredLeases() {
    const current = now()
    for (const [leaseId, lease] of this.leases.entries()) {
      if (lease.expiresAt != null && lease.expiresAt <= current) {
        this.leases.delete(leaseId)
      }
    }
  }

  private rescheduleExpirationTimer() {
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer)
      this.expirationTimer = null
    }

    const nextExpiry = [...this.leases.values()]
      .map((lease) => lease.expiresAt)
      .filter((value): value is number => typeof value === "number")
      .sort((lhs, rhs) => lhs - rhs)[0]

    if (nextExpiry == null) {
      return
    }

    const delay = Math.max(250, nextExpiry - now())
    this.expirationTimer = setTimeout(() => {
      this.pruneExpiredLeases()
      this.rescheduleExpirationTimer()
      this.syncBlocker()
    }, delay)
  }

  private desiredBlockerType(): "prevent-app-suspension" | "prevent-display-sleep" | null {
    this.pruneExpiredLeases()
    const state = this.getState()
    if (!state.active) {
      return null
    }
    if (state.options.preventIdleDisplaySleep) {
      return "prevent-display-sleep"
    }
    if (state.options.preventIdleSystemSleep) {
      return "prevent-app-suspension"
    }
    return null
  }

  private syncBlocker() {
    const nextType = this.desiredBlockerType()
    if (!this.host) {
      return
    }

    if (this.blockerId != null && this.blockerType === nextType) {
      return
    }

    if (this.blockerId != null) {
      this.host.stopPowerSaveBlocker(this.blockerId)
      this.blockerId = null
      this.blockerType = null
    }

    if (!nextType) {
      return
    }

    this.blockerId = this.host.startPowerSaveBlocker(nextType)
    this.blockerType = nextType
  }
}

const globalKey = "__openscoutKeepAliveManager"

const globalStore = globalThis as typeof globalThis & {
  [globalKey]?: ScoutKeepAliveManager
}

const manager = globalStore[globalKey] ?? new ScoutKeepAliveManager()
globalStore[globalKey] = manager

export function configureScoutKeepAliveHost(host: ScoutKeepAliveHost | null) {
  manager.configureHost(host)
}

export function getScoutKeepAliveState(): ScoutKeepAliveState {
  return manager.getState()
}

export function acquireScoutKeepAliveLease(input: AcquireScoutKeepAliveLeaseInput): ScoutKeepAliveLease {
  return manager.acquire(input)
}

export function releaseScoutKeepAliveLease(leaseId: string): boolean {
  return manager.release(leaseId)
}

export function shutdownScoutKeepAliveManager() {
  manager.shutdown()
}
