// Native restart can spend 20 seconds in stop_service, another 20 seconds in
// start_service's defensive stop, and 120 seconds waiting for broker health.
export const SCOUTD_RESTART_TIMEOUT_MS = 180_000;
