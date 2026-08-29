const RESTORING_READ_PATHS = new Set([
  "/health",
  "/v1/home",
  "/v1/node",
  "/v1/snapshot",
]);

export type BrokerStartupTrafficGateSnapshot = {
  state: "restoring" | "ready";
  mutationsAdmitted: boolean;
};

/**
 * Keep health and read models available while startup recovery finishes, but
 * do not let a canonical mutation cross the projection warm boundary.
 */
export class BrokerStartupTrafficGate {
  private mutationsAdmitted = false;

  admits(method: string | undefined, requestTarget = "/"): boolean {
    if (this.mutationsAdmitted) {
      return true;
    }
    const normalizedMethod = (method ?? "GET").toUpperCase();
    if (normalizedMethod === "OPTIONS") {
      return true;
    }
    if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
      return false;
    }
    const path = requestTarget.split("?", 1)[0] || "/";
    return RESTORING_READ_PATHS.has(path);
  }

  admitMutations(): void {
    this.mutationsAdmitted = true;
  }

  snapshot(): BrokerStartupTrafficGateSnapshot {
    return {
      state: this.mutationsAdmitted ? "ready" : "restoring",
      mutationsAdmitted: this.mutationsAdmitted,
    };
  }
}
