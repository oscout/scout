const RESTORING_READ_PATHS = new Set([
  "/health",
  "/v1/home",
  "/v1/node",
  "/v1/snapshot",
  "/v1/web/status",
]);

const RESTORING_PROCESS_CONTROL_ROUTES = new Set([
  "POST /v1/web/start",
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
    const path = requestTarget.split("?", 1)[0] || "/";
    if (normalizedMethod === "OPTIONS") {
      return true;
    }
    // Starting the broker-owned web child changes process state, not the
    // canonical control plane. Let the supervisor overlap that startup with
    // projection recovery while canonical writes remain behind this gate.
    if (RESTORING_PROCESS_CONTROL_ROUTES.has(`${normalizedMethod} ${path}`)) {
      return true;
    }
    if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
      return false;
    }
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
