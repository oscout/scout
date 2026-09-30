import { useEffect, useRef } from "react";

import {
  createBrokerRefreshController,
  type BrokerRefreshPolicy,
  type BrokerRefreshScheduler,
} from "./broker-refresh-controller.ts";
import { isBrokerEventStreamLive, useBrokerEvents } from "./sse.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "./surface-activity.ts";

export type { BrokerRefreshPolicy } from "./broker-refresh-controller.ts";

const browserScheduler: BrokerRefreshScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Keep broker-backed data fresh from events, with a timer only as a net.
 * `refresh` is not called on mount; screens do their own first load.
 */
export function useBrokerRefresh(refresh: () => void, policy: BrokerRefreshPolicy): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const controllerRef = useRef<ReturnType<typeof createBrokerRefreshController> | null>(null);

  useEffect(() => {
    const controller = createBrokerRefreshController({
      refresh: () => refreshRef.current(),
      policy: () => policyRef.current,
      isActive: () => isScoutSurfaceActive(),
      isLive: isBrokerEventStreamLive,
      scheduler: browserScheduler,
    });
    controllerRef.current = controller;
    // Tick at the tighter of the two rates; onTick decides whether it is due.
    const tickMs = Math.min(policyRef.current.fallbackPollMs, policyRef.current.livePollMs);
    const interval = globalThis.setInterval(() => controller.onTick(), tickMs);
    const stopActivation = onScoutSurfaceActivated(() => controller.onActivated());
    return () => {
      globalThis.clearInterval(interval);
      stopActivation();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useBrokerEvents((event) => controllerRef.current?.onEvent(event));
}
