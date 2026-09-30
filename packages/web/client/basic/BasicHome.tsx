import { BrokerScreen } from "../screens/broker/BrokerScreen.tsx";
import { HomeContent, SectionRule } from "../screens/home/content.tsx";
import { useScout } from "../scout/Provider.tsx";

/**
 * Home: what's moving across the fleet, then the delivery ledger. Delivery
 * filters ride `/dispatch?filter=…` so they stay linkable, but they are still
 * Home — the nav never leaves it.
 */
export function BasicHome() {
  const { route, navigate } = useScout();
  const attemptId = route.view === "broker" ? route.attemptId : undefined;

  return (
    <HomeContent navigate={navigate} basic>
      <section className="s-fleet-section sb-deliveries" aria-label="Deliveries">
        <SectionRule label="Deliveries" />
        <BrokerScreen navigate={navigate} basic initialAttemptId={attemptId} />
      </section>
    </HomeContent>
  );
}
