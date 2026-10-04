import { Component, lazy, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from "react";

import { ScoutMark } from "../components/ScoutMark.tsx";
import { api } from "../lib/api.ts";
import type { Route } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";
import { OnboardingTakeover } from "../scout/takeover/OnboardingTakeover.tsx";
import { onboardingTakeoverActive } from "../scout/takeover/onboarding-gate.ts";
import { BasicDms } from "./BasicDms.tsx";
import { BasicHome } from "./BasicHome.tsx";
import { BasicNextStep } from "./BasicNextStep.tsx";
import { BasicTail } from "./BasicTail.tsx";
import { basicArea, type BasicArea } from "./profile.ts";

/** The page set the Mac app embeds from basic; loaded only when opened. */
const BasicSettings = lazy(async () => {
  const { ScoutSettings } = await import("../screens/settings/ScoutSettings.tsx");
  function BasicSettings() {
    const { route, navigate } = useScout();
    const section = route.view === "settings" && route.section && route.section !== "agents" && route.section !== "pairing"
      ? route.section
      : "operator";
    return (
      <ScoutSettings
        section={section}
        onSectionChange={(next) => navigate({ view: "settings", section: next })}
        navigate={navigate}
        frame="flat"
      />
    );
  }
  return { default: BasicSettings };
});

const NAV: Array<{ area: BasicArea; label: string; route: Route }> = [
  { area: "home", label: "Home", route: { view: "inbox" } },
  { area: "dms", label: "DMs", route: { view: "messages" } },
  { area: "tail", label: "Tail", route: { view: "ops", mode: "tail" } },
  { area: "settings", label: "Settings", route: { view: "settings" } },
];

export function BasicApp() {
  const { route, navigate, onboarding, onboardingSkipped } = useScout();
  const area = basicArea(route);
  // Same gate as the full shell's takeover slot: first run owns the page
  // until it's finished or set aside ("Set up later" stays on every step).
  const takeover = onboardingTakeoverActive(onboarding, onboardingSkipped) === true;

  return (
    <div className="sb-shell" data-scout-theme>
      <header className="sb-header">
        <a
          className="sb-brand"
          href="/"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            navigate({ view: "inbox" });
          }}
        >
          <ScoutMark className="sb-brand-mark" />
          <span>Scout</span>
        </a>
        {!takeover && <nav className="sb-nav" aria-label="Scout">
          {NAV.map((item) => (
            <button
              key={item.area}
              type="button"
              className={`sb-nav-item${area === item.area ? " is-active" : ""}`}
              aria-current={area === item.area ? "page" : undefined}
              onClick={() => navigate(item.route)}
            >
              {item.label}
            </button>
          ))}
        </nav>}
        <BrokerStatus />
      </header>
      {takeover ? (
        <main className="sb-main sb-main--setup" aria-label="First-run setup">
          <OnboardingTakeover />
        </main>
      ) : (
        <main className={`sb-main sb-main--${area}`}>
          {area === "home" && <BasicHome lead={<BasicNextStep />} />}
          {area === "dms" && <BasicDms />}
          {area === "tail" && <BasicTail />}
          {area === "settings" && (
            <Suspense fallback={null}>
              <BasicSettings />
            </Suspense>
          )}
        </main>
      )}
    </div>
  );
}

type BrokerHealth = { reachable: boolean; ok: boolean; error: string | null };

const BROKER_HEALTH_POLL_MS = 15_000;

/** Live broker liveness; null until known, or when this server predates the route. */
function useBrokerHealth(): BrokerHealth | null {
  const [health, setHealth] = useState<BrokerHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api<BrokerHealth>("/api/broker/health")
        .then((next) => { if (!cancelled) setHealth(next); })
        .catch(() => { if (!cancelled) setHealth(null); });
    };
    check();
    const timer = window.setInterval(check, BROKER_HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return health;
}

function BrokerStatus() {
  const { apiConnection, onlineCount, agentsLoaded, operatorName } = useScout();
  const broker = useBrokerHealth();
  const offline = apiConnection.status === "offline";
  const tone = offline || broker?.reachable === false
    ? "error"
    : apiConnection.status === "degraded" || broker?.ok === false
      ? "warn"
      : apiConnection.status === "online"
        ? "ok"
        : "idle";
  const label = offline
    ? "Scout offline"
    : broker?.reachable === false
      ? "Broker unreachable"
      : broker?.ok === false
        ? "Broker degraded"
        : apiConnection.status === "degraded"
          ? "Scout degraded"
          : apiConnection.status === "online"
            ? broker ? "Broker up" : "Scout up"
            : "Connecting";
  const title = broker?.error ?? apiConnection.message ?? undefined;
  return (
    <div className="sb-status" title={title}>
      <span className={`sb-status-dot sb-status-dot--${tone}`} aria-hidden="true" />
      <span className="sb-status-label">{label}</span>
      {agentsLoaded && tone === "ok" && (
        <span className="sb-status-meta">{onlineCount} online</span>
      )}
      {operatorName && <span className="sb-status-meta sb-status-operator">@{operatorName}</span>}
    </div>
  );
}

export class BasicBootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[openscout] basic app render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="sb-crash">
        <h1>Scout could not render this view</h1>
        <pre>{this.state.error.message}</pre>
        <button type="button" onClick={() => window.location.assign("/")}>Back to Home</button>
      </main>
    );
  }
}
