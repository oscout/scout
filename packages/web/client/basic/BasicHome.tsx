import type { ReactNode } from "react";

import { BrokerScreen } from "../screens/broker/BrokerScreen.tsx";
import { HomeContent, SectionRule } from "../screens/home/content.tsx";
import type { Route } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";

/**
 * Home: what's moving across the fleet, then the delivery ledger. Delivery
 * filters ride `/dispatch?filter=…` so they stay linkable, but they are still
 * Home — the nav never leaves it.
 */
export function BasicHome({
  navigate: navigateOverride,
  lead,
}: {
  navigate?: (route: Route) => void;
  /** Next-step strip; the browser shell passes one, a native host's embed doesn't. */
  lead?: ReactNode;
} = {}) {
  const { route, navigate: scoutNavigate } = useScout();
  // A native host owns navigation when Home is embedded.
  const navigate = navigateOverride ?? scoutNavigate;
  const attemptId = route.view === "broker" ? route.attemptId : undefined;

  return (
    <HomeContent navigate={navigate} basic lead={lead}>
      <section className="s-fleet-section sb-deliveries" aria-label="Deliveries">
        <SectionRule label="Deliveries" />
        <BrokerScreen navigate={navigate} basic initialAttemptId={attemptId} />
      </section>
    </HomeContent>
  );
}
