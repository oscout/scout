import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import { BrokerAttemptInspector } from "./BrokerScreen.tsx";
import { brokerAttemptIsFailure } from "./broker-display.ts";
import { brokerDiagnosticsUrl } from "./broker-query.ts";
import type { BrokerDiagnostics, BrokerRouteAttempt, Route } from "../../lib/types.ts";

function brokerContextPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function brokerContextKindLabel(kind: BrokerRouteAttempt["kind"]): string {
  switch (kind) {
    case "success":
      return "sent";
    case "failed_query":
      return "query";
    case "failed_delivery":
      return "delivery";
    default:
      return "attempt";
  }
}

function brokerContextRouteLabel(route: string | null): string {
  switch (route) {
    case "dm":
      return "direct";
    case "channel":
      return "channel";
    case "broadcast":
      return "broadcast";
    case null:
      return "no route";
    default:
      return route;
  }
}

function brokerContextCounts(rows: BrokerRouteAttempt[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = brokerContextRouteLabel(row.route);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 5);
}

function brokerContextKindCounts(rows: BrokerRouteAttempt[]): {
  sent: number;
  query: number;
  delivery: number;
  failures: number;
} {
  const counts = { sent: 0, query: 0, delivery: 0, failures: 0 };
  for (const row of rows) {
    if (row.kind === "success") {
      counts.sent += 1;
    } else if (row.kind === "failed_query") {
      counts.query += 1;
    } else if (row.kind === "failed_delivery" || row.kind === "delivery_attempt") {
      counts.delivery += 1;
    }
    if (brokerAttemptIsFailure(row)) counts.failures += 1;
  }
  return counts;
}

function BrokerContextPanel() {
  const { inspectBrokerAttempt } = useScout();
  const [broker, setBroker] = useState<BrokerDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<BrokerDiagnostics>(brokerDiagnosticsUrl());
      setBroker(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useBrokerEvents((event) => {
    if (
      event.kind === "message.posted" ||
      event.kind === "delivery.planned" ||
      event.kind === "delivery.attempted" ||
      event.kind === "delivery.state.changed" ||
      event.kind === "scout.dispatched"
    ) {
      void load();
    }
  });

  const attentionRows = useMemo(
    () => broker
      ? [...broker.failedQueries, ...broker.failedDeliveries]
        .sort((left, right) => right.ts - left.ts)
        .slice(0, 4)
      : [],
    [broker],
  );
  const recentRows = useMemo(
    () => broker
      ? broker.attempts
        .slice()
        .sort((left, right) => right.ts - left.ts)
        .slice(0, 5)
      : [],
    [broker],
  );
  const routeMix = useMemo(
    () => broker
      ? brokerContextCounts(broker.attempts)
      : [],
    [broker],
  );
  const rowCounts = useMemo(
    () => broker ? brokerContextKindCounts(broker.attempts) : null,
    [broker],
  );

  const openAttempt = useCallback((attempt: BrokerRouteAttempt) => {
    inspectBrokerAttempt(attempt);
    window.dispatchEvent(new CustomEvent("scout:set-inspector-width", {
      detail: { width: 420 },
    }));
  }, [inspectBrokerAttempt]);

  if (!broker && !error) {
    return (
      <div className="flex h-full flex-col overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
        <BrokerContextSummaryCard title="Dispatch context" status="Loading broker ledger..." />
      </div>
    );
  }

  if (!broker) {
    return (
      <div className="flex h-full flex-col overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
        <BrokerContextSummaryCard title="Dispatch context" status="Broker diagnostics unavailable" />
        <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] p-2.5 text-sm leading-relaxed text-[var(--scout-chrome-ink-soft)]">
          {error}
        </div>
      </div>
    );
  }

  const routeTotal = broker.attempts.length;
  const routeTotalSuffix = broker.ledger.hasMore.attempts ? "+" : "";
  const failureRate = routeTotal > 0 && rowCounts ? rowCounts.failures / routeTotal : 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
      <BrokerContextSummaryCard
        title="Dispatch context"
        status={`${routeTotal}${routeTotalSuffix} latest route${routeTotal === 1 ? "" : "s"}`}
      >
        <div className="mt-2 grid grid-cols-3 gap-1">
          <BrokerMiniStat label="Sent" value={`${rowCounts?.sent ?? 0}`} />
          <BrokerMiniStat label="Query" value={`${rowCounts?.query ?? 0}`} />
          <BrokerMiniStat label="Delivery" value={`${rowCounts?.delivery ?? 0}`} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--scout-chrome-border-soft)] pt-2 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
          <span>{brokerContextPercent(failureRate)} failed</span>
          <span>{timeAgo(broker.generatedAt)}</span>
        </div>
      </BrokerContextSummaryCard>

      <BrokerContextSection label="Route mix">
        <BrokerPillList items={routeMix} empty="No route records visible" />
      </BrokerContextSection>

      <BrokerContextSection label="Needs attention">
        {attentionRows.length === 0 ? (
          <BrokerEmptyLine>No failed routes in history.</BrokerEmptyLine>
        ) : (
          <div className="flex flex-col gap-1.5">
            {attentionRows.map((attempt) => (
              <BrokerContextAttemptButton
                key={attempt.id}
                attempt={attempt}
                onOpen={openAttempt}
              />
            ))}
          </div>
        )}
      </BrokerContextSection>

      <BrokerContextSection label="Recent dispatch">
        {recentRows.length === 0 ? (
          <BrokerEmptyLine>No recent dispatch rows.</BrokerEmptyLine>
        ) : (
          <div className="flex flex-col gap-1">
            {recentRows.map((attempt) => (
              <BrokerContextAttemptButton
                key={attempt.id}
                attempt={attempt}
                onOpen={openAttempt}
                compact
              />
            ))}
          </div>
        )}
      </BrokerContextSection>
    </div>
  );
}

function BrokerContextSummaryCard({
  title,
  status,
  children,
}: {
  title: string;
  status: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] p-2.5">
      <div className="text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
        {title}
      </div>
      <div className="mt-1 font-mono text-xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-soft)]">
        {status}
      </div>
      {children}
    </div>
  );
}

function BrokerMiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-sm border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-bg)] px-1.5 py-1">
      <div className="font-mono text-2xs uppercase tracking-[0.1em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-lg text-[var(--scout-chrome-ink-strong)]">
        {value}
      </div>
    </div>
  );
}

function BrokerContextSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="mb-1.5 text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function BrokerPillList({
  items,
  empty,
}: {
  items: Array<{ label: string; count: number }>;
  empty: string;
}) {
  if (items.length === 0) return <BrokerEmptyLine>{empty}</BrokerEmptyLine>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item.label}
          className="rounded-sm border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] px-1.5 py-0.5 font-mono text-xs text-[var(--scout-chrome-ink-soft)]"
          title={`${item.count} ${item.label}`}
        >
          {item.label} {item.count}
        </span>
      ))}
    </div>
  );
}

function BrokerEmptyLine({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-mono uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
      {children}
    </div>
  );
}

function BrokerContextAttemptButton({
  attempt,
  onOpen,
  compact = false,
}: {
  attempt: BrokerRouteAttempt;
  onOpen: (attempt: BrokerRouteAttempt) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] px-2 py-1.5 text-left transition-colors hover:border-[var(--scout-chrome-border)]"
      onClick={() => onOpen(attempt)}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-sm bg-[var(--scout-chrome-bg)] px-1 py-0.5 font-mono text-3xs uppercase tracking-[0.08em] text-[var(--scout-chrome-ink-faint)]">
          {brokerContextKindLabel(attempt.kind)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--scout-chrome-ink)]">
          {attempt.detail}
        </span>
        <span className="shrink-0 font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">
          {timeAgo(attempt.ts)}
        </span>
      </div>
      {!compact && (
        <div className="mt-0.5 flex items-center gap-2 font-mono text-2xs text-[var(--scout-chrome-ink-ghost)]">
          <span className="truncate">{attempt.actorName ?? "unknown"}</span>
          <span className="shrink-0">-&gt;</span>
          <span className="truncate">{attempt.target ?? "none"}</span>
        </div>
      )}
    </button>
  );
}

export function BrokerRight({
  selectedAttempt,
  navigate,
  onClose,
}: {
  selectedAttempt: import("../../lib/types.ts").BrokerRouteAttempt | null;
  navigate: (route: Route) => void;
  onClose: () => void;
}) {
  if (selectedAttempt) {
    return (
      <BrokerAttemptInspector
        attempt={selectedAttempt}
        navigate={navigate}
        onClose={onClose}
      />
    );
  }
  return <BrokerContextPanel />;
}
