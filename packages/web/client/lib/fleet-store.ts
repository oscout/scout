import { api } from "./api.ts";
import { FLEET_EVENT_KINDS } from "./broker-event-kinds.ts";
import { createFleetStore } from "./fleet-store-core.ts";
import { isBrokerReconcileEvent } from "./broker-refresh-controller.ts";
import { observeBrokerEvents } from "./sse.ts";
import type { FleetState } from "./types.ts";

// Long enough to span the slowest reader's debounce after one event, short
// enough that a timer-driven reader still sees a fresh `generatedAt`.
const FLEET_READ_MAX_AGE_MS = 2_500;

const fleetKinds = new Set<string>(FLEET_EVENT_KINDS);
const store = createFleetStore<FleetState>({
  fetch: (path) => api<FleetState>(path),
  maxAgeMs: FLEET_READ_MAX_AGE_MS,
});

observeBrokerEvents((event) => {
  if (fleetKinds.has(event.kind) || isBrokerReconcileEvent(event)) store.invalidate();
});

/**
 * Read `/api/fleet` (with optional query), shared across every caller since
 * the last fleet event. The result is shared too: treat it as immutable.
 */
export function loadFleet(query = ""): Promise<FleetState> {
  return store.load(query ? `/api/fleet?${query}` : "/api/fleet");
}
