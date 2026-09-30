import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";

import { ScoutMark } from "../components/ScoutMark.tsx";
import { api } from "../lib/api.ts";
import type { Route } from "../lib/types.ts";
import { useScout } from "../scout/Provider.tsx";
import { BasicDms } from "./BasicDms.tsx";
import { BasicHome } from "./BasicHome.tsx";
import { BasicTail } from "./BasicTail.tsx";
import { basicArea, type BasicArea } from "./profile.ts";

const NAV: Array<{ area: BasicArea; label: string; route: Route }> = [
  { area: "home", label: "Home", route: { view: "inbox" } },
  { area: "dms", label: "DMs", route: { view: "messages" } },
  { area: "tail", label: "Tail", route: { view: "ops", mode: "tail" } },
];

export function BasicApp() {
  const { route, navigate } = useScout();
  const area = basicArea(route);

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
        <nav className="sb-nav" aria-label="Scout">
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
        </nav>
        <BrokerStatus />
      </header>
      <main className={`sb-main sb-main--${area}`}>
        {area === "home" && <BasicHome />}
        {area === "dms" && <BasicDms />}
        {area === "tail" && <BasicTail />}
      </main>
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
