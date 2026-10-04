import { useLayoutEffect, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import type { Route } from "../../lib/types.ts";
import "./home-hero.css";
import {
  formatResetChip,
  formatResetRelative,
  formatWeeklyResetCountdown,
  quotaWindowRolledOver,
} from "./quota-reset.ts";

type HeartrateBucketView = { ts: number; count: number; value: number };

type GaugeTone = "ok" | "warn" | "err" | "dim";

type ServiceQuotaHistoryPoint = {
  capturedAt: number;
  fill: number;
  usedLabel: string;
  resetAt?: number;
};

type ServiceQuotaWindowGauge = {
  label: string;
  fill: number;
  usedLabel: string;
  capLabel: string;
  unitLabel: string;
  resetAt: number;
  windowMs?: number;
  capturedAt?: number;
  source?: string;
  history?: ServiceQuotaHistoryPoint[];
  /** The last reading predates this window's reset; current usage is unknown. */
  awaitingReset?: boolean;
};

export type ServiceGauge =
  | {
      id: string;
      label: string;
      kind: "quota";
      fill: number;
      usedLabel: string;
      capLabel: string;
      unitLabel: string;
      resetAt: number;
      windows?: ServiceQuotaWindowGauge[];
      plan?: string;
      capturedAt?: number;
      source?: string;
    }
  | {
      id: string;
      label: string;
      kind: "status";
      statusLabel: string;
      windowLabel?: string;
      detailLabel?: string;
      tone: GaugeTone;
      capturedAt?: number;
      source?: string;
    };

export type HomeHeroProps = {
  now: Date;
  operatorName?: string;
  syncLabel: string;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  navigate: (route: Route) => void;
  heartrate: HeartrateBucketView[];
  heartrateWindow: string;
  heartrateBucketLabel: string;
  heartrateVisibleEventThreshold?: number;
  serviceGauges: ServiceGauge[];
  /** First fetch still in flight: reserve the card instead of growing into it. */
  gaugesPending?: boolean;
  heartratePending?: boolean;
  /** Last settled cockpit shape; sizes the pending cards. */
  layoutHint?: { gauges: number; heartrate: boolean };
};

const HEARTRATE_VISIBLE_EVENT_THRESHOLD = 3;
const HOME_SERVICE_GAUGE_LIMIT = 2;

function gaugeTone(fill: number): GaugeTone {
  if (fill >= 0.9) return "err";
  if (fill >= 0.75) return "warn";
  return "ok";
}

function quotaWindows(g: Extract<ServiceGauge, { kind: "quota" }>): ServiceQuotaWindowGauge[] {
  return g.windows && g.windows.length > 0
    ? g.windows
    : [
        {
          label: formatLegacyQuotaLabel(g.unitLabel),
          fill: g.fill,
          usedLabel: g.usedLabel,
          capLabel: g.capLabel,
          unitLabel: g.unitLabel,
          resetAt: g.resetAt,
        },
      ];
}

function formatLegacyQuotaLabel(label: string): string {
  switch (label) {
    case "weekly":
      return "7d";
    case "req/h":
      return "1h";
    default:
      return label || "quota";
  }
}

function buildTooltip(g: Extract<ServiceGauge, { kind: "quota" }>, now: Date): string {
  return quotaWindows(g)
    .map((window) => {
      if (quotaWindowRolledOver(window, now)) {
        return `${window.label}: rolled over, awaiting a fresh reading`;
      }
      const chip = formatResetChip(window.resetAt, now);
      const rel = formatResetRelative(window, now);
      return `${window.label}: ${window.usedLabel} / ${window.capLabel} ${window.unitLabel} · resets ${chip.label} (in ${rel})`;
    })
    .join(" · ");
}

function quotaWindowMinutes(label: string): number | null {
  const match = label.trim().match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]?.toLowerCase()) {
    case "m":
      return value;
    case "h":
      return value * 60;
    case "d":
      return value * 24 * 60;
    default:
      return null;
  }
}

function splitQuotaWindows(windows: ServiceQuotaWindowGauge[]): {
  shortWindow: ServiceQuotaWindowGauge | null;
  longWindow: ServiceQuotaWindowGauge | null;
} {
  const sorted = [...windows].sort(
    (a, b) =>
      (quotaWindowMinutes(a.label) ?? Number.MAX_SAFE_INTEGER) -
      (quotaWindowMinutes(b.label) ?? Number.MAX_SAFE_INTEGER),
  );
  const longWindow =
    sorted.find((window) => (quotaWindowMinutes(window.label) ?? 0) >= 24 * 60) ??
    (sorted.length > 1 ? sorted[sorted.length - 1]! : null);
  const shortWindow = sorted.find((window) => window !== longWindow) ?? null;
  return { shortWindow, longWindow };
}

/** A rolled-over window's last reading belongs to the previous cycle. */
function currentWindowFill(window: ServiceQuotaWindowGauge, now: Date): number {
  return quotaWindowRolledOver(window, now) ? 0 : window.fill;
}

function usageLabel(window: ServiceQuotaWindowGauge, now: Date): string {
  if (quotaWindowRolledOver(window, now)) return "—";
  if (window.capLabel === "100%" && window.usedLabel.endsWith("%")) {
    return window.usedLabel;
  }
  return `${window.usedLabel}/${window.capLabel}`;
}

function EmptyGaugeCell() {
  return <span className="hd-gauge-cell hd-gauge-cell--empty">—</span>;
}

function QuotaUsageCell({ window, now }: { window: ServiceQuotaWindowGauge | null; now: Date }) {
  if (!window) return <EmptyGaugeCell />;
  const fill = currentWindowFill(window, now);
  const windowPct = Math.round(fill * 100);
  const windowTone = gaugeTone(fill);
  return (
    <span className="hd-gauge-cell hd-gauge-cell--usage">
      <span className="hd-gauge-window-name label-xs">{window.label}</span>
      <span className="hd-gauge-bar" aria-hidden="true">
        <span
          className={`hd-gauge-bar-fill hd-gauge-bar-fill--${windowTone}`}
          style={{ width: `${windowPct}%` }}
        />
      </span>
      <span className="hd-gauge-window-used">{usageLabel(window, now)}</span>
    </span>
  );
}

function QuotaResetCell({
  window,
  now,
  featured = false,
}: {
  window: ServiceQuotaWindowGauge | null;
  now: Date;
  featured?: boolean;
}) {
  if (!window) return <EmptyGaugeCell />;
  if (featured) {
    const countdown = formatWeeklyResetCountdown(window, now);
    return (
      <span
        className={`hd-gauge-cell hd-gauge-reset hd-gauge-reset--featured hd-gauge-reset--${countdown.tone}`}
        aria-live="off"
        aria-label={countdown.ariaLabel}
      >
        <strong>{countdown.primary}</strong>
        {countdown.dateTime ? (
          <time dateTime={countdown.dateTime}>{countdown.secondary}</time>
        ) : (
          <span>{countdown.secondary}</span>
        )}
      </span>
    );
  }
  const chip = formatResetChip(window.resetAt, now);
  const rel = formatResetRelative(window, now);
  return (
    <span className={`hd-gauge-cell hd-gauge-reset${chip.imminent ? " hd-gauge-reset--imminent" : ""}`}>
      ↻ {rel}
    </span>
  );
}

function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const segs: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    segs.push(`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`);
  }
  return segs.join(" ");
}

function useMeasuredWidth(fallback: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const sync = (next: number) => {
      const rounded = Math.round(next);
      if (rounded > 0) setWidth((current) => (current === rounded ? current : rounded));
    };
    sync(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      sync(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

function HeartrateGraph({ buckets }: { buckets: HeartrateBucketView[] }) {
  const [ref, W] = useMeasuredWidth(372);
  const H = 72;
  const top = 8;
  const bottom = 54;
  const labelY = 67;
  const N = buckets.length;
  const allZero = N < 2 || buckets.every((b) => b.count === 0);
  const plotW = Math.max(1, W - 4);

  const svgProps = {
    viewBox: `0 0 ${W} ${H}`,
    style: { width: "100%", height: H, display: "block" } as const,
  };

  if (allZero) {
    return (
      <div ref={ref} className="hd-heartrate-svg-wrap">
        <svg {...svgProps}>
          <line x1="0" y1={bottom} x2={W} y2={bottom} stroke="var(--border)" />
        </svg>
      </div>
    );
  }

  const stepX = plotW / (N - 1);
  const points = buckets.map((b, i) => ({
    x: i * stepX,
    y: bottom - Math.max(0, Math.min(1, b.value)) * (bottom - top),
  }));
  const path = buildSmoothPath(points);
  const areaPath = `${path} L ${plotW} ${bottom} L 0 ${bottom} Z`;

  return (
    <div ref={ref} className="hd-heartrate-svg-wrap">
      <svg {...svgProps}>
        <defs>
          <linearGradient id="hrdFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={top} x2={W} y2={top} stroke="var(--border)" opacity="0.25" />
        <line x1="0" y1={(top + bottom) / 2} x2={W} y2={(top + bottom) / 2} stroke="var(--border)" opacity="0.25" />
        <line x1="0" y1={bottom} x2={W} y2={bottom} stroke="var(--border)" />
        <path d={areaPath} fill="url(#hrdFill)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" />
        <circle cx={points[N - 1].x} cy={points[N - 1].y} r="3" fill="var(--accent)" />
        <circle cx={points[N - 1].x} cy={points[N - 1].y} r="6" fill="var(--accent)" opacity="0.25" />
        <text x="0" y={labelY} fill="var(--dim)" fontSize="9" fontFamily="var(--font-mono)">7d</text>
        <text x={W / 2} y={labelY} textAnchor="middle" fill="var(--dim)" fontSize="9" fontFamily="var(--font-mono)">3d</text>
        <text x={W} y={labelY} textAnchor="end" fill="var(--dim)" fontSize="9" fontFamily="var(--font-mono)">now</text>
      </svg>
    </div>
  );
}

function Gauge({
  gauge,
  now,
  onClick,
}: {
  gauge: ServiceGauge;
  now: Date;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "span";
  const interactiveProps = onClick
    ? { type: "button" as const, onClick }
    : {};

  if (gauge.kind === "status") {
    return (
      <Tag
        className={`hd-gauge hd-gauge--status hd-gauge--${gauge.tone}${onClick ? " hd-gauge--interactive" : ""}`}
        aria-label={`${gauge.label} subscription usage`}
        {...interactiveProps}
      >
        <span className="hd-gauge-head">
          <span className="hd-gauge-label">{gauge.label}</span>
          <span className={`hd-gauge-dot hd-gauge-dot--${gauge.tone}`} aria-hidden="true" />
        </span>
        <EmptyGaugeCell />
        <EmptyGaugeCell />
        <span className="hd-gauge-cell hd-gauge-cell--usage hd-gauge-cell--status">
          <span className="hd-gauge-window-name label-xs">{gauge.windowLabel ?? "usage"}</span>
          <span className="hd-gauge-status">{gauge.statusLabel}</span>
        </span>
        <span className="hd-gauge-cell hd-gauge-reset">{gauge.detailLabel ?? "quota n/a"}</span>
      </Tag>
    );
  }
  const windows = quotaWindows(gauge);
  const { shortWindow, longWindow } = splitQuotaWindows(windows);
  const peakFill = Math.max(...windows.map((window) => currentWindowFill(window, now)));
  const tone = gaugeTone(peakFill);
  const allRolledOver = windows.every((window) => quotaWindowRolledOver(window, now));
  const pctLabel = allRolledOver ? "—" : `${Math.round(peakFill * 100)}%`;
  return (
    <Tag
      className={`hd-gauge hd-gauge--${tone}${onClick ? " hd-gauge--interactive" : ""}`}
      title={buildTooltip(gauge, now)}
      aria-label={`${gauge.label} subscription usage. ${buildTooltip(gauge, now)}`}
      {...interactiveProps}
    >
      <span className="hd-gauge-head">
        <span className="hd-gauge-label">{gauge.label}</span>
        <span className={`hd-gauge-pct hd-gauge-pct--${tone}`}>{pctLabel}</span>
      </span>
      <QuotaUsageCell window={shortWindow} now={now} />
      <QuotaResetCell window={shortWindow} now={now} />
      <QuotaUsageCell window={longWindow} now={now} />
      <QuotaResetCell window={longWindow} now={now} featured />
    </Tag>
  );
}

function compactNumberValue(label: string): number {
  const match = label.trim().match(/^(\d+(?:\.\d+)?)([kKmM])?$/u);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  switch (match[2]?.toLowerCase()) {
    case "m":
      return value * 1_000_000;
    case "k":
      return value * 1_000;
    default:
      return value;
  }
}

function gaugeUsageScore(gauge: ServiceGauge): number {
  if (gauge.kind === "quota") {
    return Math.max(gauge.fill, ...quotaWindows(gauge).map((window) => window.fill));
  }
  return compactNumberValue(gauge.statusLabel) > 0 ? 0.01 : 0;
}

function isQuotaGauge(gauge: ServiceGauge): gauge is Extract<ServiceGauge, { kind: "quota" }> {
  return gauge.kind === "quota";
}

function topServiceGauges(gauges: ServiceGauge[]): ServiceGauge[] {
  return sortedServiceGauges(gauges).slice(0, HOME_SERVICE_GAUGE_LIMIT);
}

function sortedServiceGauges(gauges: ServiceGauge[]): ServiceGauge[] {
  return gauges
    .map((gauge, index) => ({ gauge, index, score: gaugeUsageScore(gauge) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ gauge }) => gauge);
}

/* Pending cards reuse the real chrome and row classes, with invisible text
   holding each line box, so the swap to data changes pixels, not geometry. */
function QuotasCardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="hd-card hd-card--quotas hd-card--pending" aria-hidden="true">
      <div className="hd-card-head">
        <div className="hd-card-head-left">
          <span className="label-xs hd-card-title">Subscriptions & Quotas</span>
          <span className="chip chip--neutral chip--mono chip--sm home-skel-chip">0 Active</span>
        </div>
      </div>
      <div className="hd-gauge-set">
        <div className="hd-gauge-table-head label-xs">
          <span>Service</span>
          <span>Short Window</span>
          <span>Resets</span>
          <span>Long Window</span>
          <span>Reset Countdown</span>
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="hd-gauge-wrap">
            <span className="hd-gauge">
              <span className="hd-gauge-head">
                <span className="hd-gauge-label"><span className="home-skel" style={{ width: 44 }} />{"\u00a0"}</span>
              </span>
              <span className="hd-gauge-cell"><span className="home-skel" style={{ width: "80%" }} /></span>
              <span className="hd-gauge-cell hd-gauge-reset"><span className="home-skel" style={{ width: 40 }} /></span>
              <span className="hd-gauge-cell"><span className="home-skel" style={{ width: "80%" }} /></span>
              <span className="hd-gauge-cell hd-gauge-reset hd-gauge-reset--featured">
                <strong><span className="home-skel" style={{ width: 64 }} />{"\u00a0"}</strong>
                <span>{"\u00a0"}</span>
              </span>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function HeartrateCardSkeleton() {
  return (
    <div className="hd-card hd-card--heartrate hd-card--pending" aria-hidden="true">
      <div className="hd-card-head">
        <div className="hd-card-head-left">
          <Activity size={12} className="hd-heartrate-icon" aria-hidden="true" />
          <span className="label-xs hd-card-title">Fleet Velocity</span>
        </div>
        <div className="hd-card-head-right">
          <span className="chip chip--neutral chip--mono chip--sm home-skel-chip">0 Events</span>
        </div>
      </div>
      <div className="hd-heartrate-plot-body">
        <HeartrateGraph buckets={[]} />
      </div>
    </div>
  );
}

export default function HomeHero(props: HomeHeroProps) {
  const {
    now,
    operatorName,
    syncLabel,
    error,
    loading,
    refreshing,
    onRefresh,
    navigate,
    heartrate,
    heartrateWindow,
    heartrateBucketLabel,
    heartrateVisibleEventThreshold = HEARTRATE_VISIBLE_EVENT_THRESHOLD,
    serviceGauges,
    gaugesPending = false,
    heartratePending = false,
    layoutHint = { gauges: HOME_SERVICE_GAUGE_LIMIT, heartrate: true },
  } = props;
  const [showAllGauges, setShowAllGauges] = useState(false);

  const syncTone = loading || refreshing ? "pending" : error ? "err" : "ok";
  const subscriptionGauges = serviceGauges.filter(isQuotaGauge);
  const sortedGauges = sortedServiceGauges(subscriptionGauges);
  const compactGauges = topServiceGauges(subscriptionGauges);
  const gauges = showAllGauges ? sortedGauges : compactGauges;
  const hasHiddenGauges = subscriptionGauges.length > compactGauges.length;

  const totalHeartrateEvents = heartrate.reduce((total, bucket) => total + bucket.count, 0);
  const showHeartrate = totalHeartrateEvents >= heartrateVisibleEventThreshold;
  // While a source is unresolved its card holds the slot it last occupied, so
  // the grid never reflows from one column to two when the data lands.
  const reserveGauges = gauges.length === 0 && gaugesPending && layoutHint.gauges > 0;
  const reserveHeartrate = !showHeartrate && heartratePending && layoutHint.heartrate;
  const hasQuotasCard = gauges.length > 0 || reserveGauges;
  const hasHeartrateCard = showHeartrate || reserveHeartrate;

  return (
    <section className="hd" aria-label="Fleet Cockpit and Service Cluster">
      {/* ── Cockpit Vitals Band ────────────────────────────────────── */}
      <div className="hd-vitals-band">
        <div className="hd-vitals-left">
          <span className="s-eyebrow hd-vitals-title">Fleet Cockpit</span>
          {operatorName && (
            <span className="chip chip--neutral chip--mono chip--sm hd-vitals-callsign">
              {operatorName}
            </span>
          )}
        </div>
        <span className="s-section-rule-line" aria-hidden="true" />
        <div className="hd-vitals-right">
          {error && !loading && !refreshing && <span className="dot dot--warning" aria-hidden="true" />}
          <span className={`hd-meta hd-meta--${syncTone}`}>{syncLabel}</span>
          <button
            type="button"
            className="hd-refresh-btn"
            disabled={loading || refreshing}
            onClick={onRefresh}
            title="Refresh status (r)"
            aria-label={refreshing ? "Refreshing status" : "Refresh status"}
          >
            <RefreshCw size={11} className={refreshing ? "hd-spin" : ""} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* ── Modular HUD Telemetry Cards ────────────────────────────── */}
      {(hasQuotasCard || hasHeartrateCard) && (
        <div className={`hd-telemetry-grid ${hasQuotasCard && hasHeartrateCard ? "hd-telemetry-grid--split" : "hd-telemetry-grid--single"}`}>
          {reserveGauges && <QuotasCardSkeleton rows={layoutHint.gauges} />}
          {/* Subscriptions & Quotas Card */}
          {gauges.length > 0 && (
            <div className="hd-card hd-card--quotas home-arrive">
              <div className="hd-card-head">
                <div className="hd-card-head-left">
                  <span className="label-xs hd-card-title">Subscriptions & Quotas</span>
                  <span className="chip chip--neutral chip--mono chip--sm">
                    {gauges.length} Active
                  </span>
                </div>
                {hasHiddenGauges && (
                  <button
                    type="button"
                    className="hd-gauge-toggle"
                    aria-expanded={showAllGauges}
                    onClick={() => setShowAllGauges((value) => !value)}
                  >
                    [{showAllGauges ? "Top 2" : `All ${subscriptionGauges.length}`}]
                  </button>
                )}
              </div>

              <div className="hd-gauge-set">
                <div className="hd-gauge-table-head label-xs" aria-hidden="true">
                  <span>Service</span>
                  <span>Short Window</span>
                  <span>Resets</span>
                  <span>Long Window</span>
                  <span>Reset Countdown</span>
                </div>
                {gauges.map((g) => (
                  <span key={g.id} className="hd-gauge-wrap">
                    <Gauge gauge={g} now={now} onClick={() => navigate({ view: "harnesses" })} />
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Fleet Velocity & Heartrate Oscilloscope Card */}
          {reserveHeartrate && <HeartrateCardSkeleton />}
          {showHeartrate && (
            <div className="hd-card hd-card--heartrate home-arrive">
              <div className="hd-card-head">
                <div className="hd-card-head-left">
                  <Activity size={12} className="hd-heartrate-icon" aria-hidden="true" />
                  <span className="label-xs hd-card-title">Fleet Velocity</span>
                </div>
                <div className="hd-card-head-right">
                  <span className="label-xs hd-card-sub">
                    {heartrateWindow} {heartrateBucketLabel ? `· ${heartrateBucketLabel}` : ""}
                  </span>
                  <span className="chip chip--working chip--mono chip--sm">
                    {totalHeartrateEvents} {totalHeartrateEvents === 1 ? "Event" : "Events"}
                  </span>
                </div>
              </div>
              <div className="hd-heartrate-plot-body">
                <HeartrateGraph buckets={heartrate} />
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
