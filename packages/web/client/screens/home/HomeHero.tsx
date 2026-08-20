import { useLayoutEffect, useRef, useState } from "react";
import type { Route } from "../../lib/types.ts";
import "./home-hero.css";

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
  capturedAt?: number;
  source?: string;
  history?: ServiceQuotaHistoryPoint[];
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
};

const HEARTRATE_VISIBLE_EVENT_THRESHOLD = 3;
const HOME_SERVICE_GAUGE_LIMIT = 2;

function gaugeTone(fill: number): GaugeTone {
  if (fill >= 0.9) return "err";
  if (fill >= 0.75) return "warn";
  return "ok";
}

const SHORT_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatResetChip(resetAt: number, now: Date): { label: string; imminent: boolean } {
  const diffMs = resetAt - now.getTime();
  const sameDay =
    new Date(resetAt).toDateString() === now.toDateString();
  const reset = new Date(resetAt);
  const hh = String(reset.getHours()).padStart(2, "0");
  const mm = String(reset.getMinutes()).padStart(2, "0");
  const imminent = diffMs > 0 && diffMs < 6 * 3600 * 1000;
  if (sameDay) {
    return { label: `${hh}:${mm}`, imminent };
  }
  return { label: `${SHORT_WEEKDAY[reset.getDay()]} ${hh}:${mm}`, imminent };
}

function formatResetRelative(resetAt: number, now: Date): string {
  const rawDiffSec = Math.floor((resetAt - now.getTime()) / 1000);
  const stale = rawDiffSec < 0;
  const diffSec = Math.abs(rawDiffSec);
  let label: string;
  if (diffSec >= 86400) {
    const d = Math.floor(diffSec / 86400);
    const h = Math.floor((diffSec % 86400) / 3600);
    label = h > 0 ? `${d}d ${h}h` : `${d}d`;
  } else if (diffSec >= 3600) {
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    label = m > 0 ? `${h}h ${m}m` : `${h}h`;
  } else {
    label = `${Math.max(1, Math.floor(diffSec / 60))}m`;
  }
  return stale ? `stale ${label}` : label;
}

function quotaWindows(g: Extract<ServiceGauge, { kind: "quota" }>): ServiceQuotaWindowGauge[] {
  return g.windows && g.windows.length > 0
    ? g.windows
    : [{
        label: formatLegacyQuotaLabel(g.unitLabel),
        fill: g.fill,
        usedLabel: g.usedLabel,
        capLabel: g.capLabel,
        unitLabel: g.unitLabel,
        resetAt: g.resetAt,
      }];
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
      const chip = formatResetChip(window.resetAt, now);
      const rel = formatResetRelative(window.resetAt, now);
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
  const sorted = [...windows].sort((a, b) =>
    (quotaWindowMinutes(a.label) ?? Number.MAX_SAFE_INTEGER) -
    (quotaWindowMinutes(b.label) ?? Number.MAX_SAFE_INTEGER),
  );
  const longWindow =
    sorted.find((window) => (quotaWindowMinutes(window.label) ?? 0) >= 24 * 60) ??
    (sorted.length > 1 ? sorted[sorted.length - 1]! : null);
  const shortWindow = sorted.find((window) => window !== longWindow) ?? null;
  return { shortWindow, longWindow };
}

function usageLabel(window: ServiceQuotaWindowGauge): string {
  if (window.capLabel === "100%" && window.usedLabel.endsWith("%")) {
    return window.usedLabel;
  }
  return `${window.usedLabel}/${window.capLabel}`;
}

function EmptyGaugeCell() {
  return <span className="hd-gauge-cell hd-gauge-cell--empty">—</span>;
}

function QuotaUsageCell({ window }: { window: ServiceQuotaWindowGauge | null }) {
  if (!window) return <EmptyGaugeCell />;
  const windowPct = Math.round(window.fill * 100);
  const windowTone = gaugeTone(window.fill);
  return (
    <span className="hd-gauge-cell hd-gauge-cell--usage">
      <span className="hd-gauge-window-name">{window.label}</span>
      <span className="hd-gauge-bar" aria-hidden="true">
        <span className={`hd-gauge-bar-fill hd-gauge-bar-fill--${windowTone}`} style={{ width: `${windowPct}%` }} />
      </span>
      <span className="hd-gauge-window-used">{usageLabel(window)}</span>
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
    const countdown = formatWeeklyResetCountdown(window.resetAt, now);
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
  const rel = formatResetRelative(window.resetAt, now);
  return (
    <span className={`hd-gauge-cell hd-gauge-reset${chip.imminent ? " hd-gauge-reset--imminent" : ""}`}>
      ↻ {rel}
    </span>
  );
}

function formatWeeklyResetCountdown(resetAt: number, now: Date): {
  primary: string;
  secondary: string;
  ariaLabel: string;
  tone: "normal" | "imminent" | "due" | "stale";
  dateTime?: string;
} {
  if (!Number.isFinite(resetAt)) {
    return {
      primary: "—",
      secondary: "unknown",
      ariaLabel: "Weekly reset time unknown",
      tone: "stale",
    };
  }

  const diffMs = resetAt - now.getTime();
  const reset = new Date(resetAt);
  if (!Number.isFinite(reset.getTime())) {
    return {
      primary: "—",
      secondary: "unknown",
      ariaLabel: "Weekly reset time unknown",
      tone: "stale",
    };
  }
  const dateTime = reset.toISOString();
  if (diffMs <= 0) {
    const overdueMs = Math.abs(diffMs);
    if (overdueMs <= 90_000) {
      return {
        primary: "reset due",
        secondary: "refreshing…",
        ariaLabel: "Weekly reset due; refreshing usage",
        tone: "due",
        dateTime,
      };
    }
    const overdueMinutes = Math.floor(overdueMs / 60_000);
    const overdueLabel = overdueMinutes >= 60
      ? `+${Math.floor(overdueMinutes / 60)}h ${overdueMinutes % 60}m`
      : `+${Math.max(1, overdueMinutes)}m`;
    return {
      primary: overdueMs <= 6 * 60 * 60_000 ? "reset due" : "stale",
      secondary: overdueLabel,
      ariaLabel: `Weekly reset data ${overdueLabel} overdue`,
      tone: overdueMs <= 6 * 60 * 60_000 ? "due" : "stale",
      dateTime,
    };
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  const primary = days > 0 ? `${days}d ${clock}` : clock;
  const today = reset.toDateString() === now.toDateString();
  const absolute = reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const secondary = today
    ? `today ${absolute}`
    : `${reset.toLocaleDateString([], { weekday: "short" })} ${absolute}`;
  const coarse = days > 0
    ? `${days} ${days === 1 ? "day" : "days"} ${hours} hours`
    : `${hours} hours ${minutes} minutes`;
  return {
    primary,
    secondary,
    ariaLabel: `Weekly quota resets in ${coarse}; ${secondary}`,
    tone: diffMs < 6 * 60 * 60_000 ? "imminent" : "normal",
    dateTime,
  };
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

/* The graph is drawn at 1:1 against its own measured width so the viewBox never
 * letterboxes: a fixed viewBox in a fluid panel would scale to `meet` and leave
 * the plot stranded as a narrow island in the middle of the panel. */
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
  const H = 70;
  const top = 6;
  const bottom = 56;
  const labelY = 67;
  const N = buckets.length;
  const allZero = N < 2 || buckets.every((b) => b.count === 0);
  // Keep the trailing marker inside the box instead of clipping it at the edge.
  const plotW = Math.max(1, W - 3);

  const svgProps = {
    viewBox: `0 0 ${W} ${H}`,
    style: { width: "100%", height: H, display: "block" } as const,
  };

  if (allZero) {
    return (
      <div ref={ref}>
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
    <div ref={ref}>
      <svg {...svgProps}>
        <defs>
          <linearGradient id="hrdFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={top} x2={W} y2={top} stroke="var(--border)" opacity="0.18" />
        <line x1="0" y1={(top + bottom) / 2} x2={W} y2={(top + bottom) / 2} stroke="var(--border)" opacity="0.22" />
        <line x1="0" y1={bottom} x2={W} y2={bottom} stroke="var(--border)" />
        <path d={areaPath} fill="url(#hrdFill)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx={points[N - 1].x} cy={points[N - 1].y} r="2.5" fill="var(--accent)" />
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
          <span className="hd-gauge-window-name">{gauge.windowLabel ?? "usage"}</span>
          <span className="hd-gauge-status">{gauge.statusLabel}</span>
        </span>
        <span className="hd-gauge-cell hd-gauge-reset">{gauge.detailLabel ?? "quota n/a"}</span>
      </Tag>
    );
  }
  const windows = quotaWindows(gauge);
  const { shortWindow, longWindow } = splitQuotaWindows(windows);
  const tone = gaugeTone(Math.max(...windows.map((window) => window.fill)));
  const pct = Math.round(Math.max(...windows.map((window) => window.fill)) * 100);
  return (
    <Tag
      className={`hd-gauge hd-gauge--${tone}${onClick ? " hd-gauge--interactive" : ""}`}
      title={buildTooltip(gauge, now)}
      aria-label={`${gauge.label} subscription usage. ${buildTooltip(gauge, now)}`}
      {...interactiveProps}
    >
      <span className="hd-gauge-head">
        <span className="hd-gauge-label">{gauge.label}</span>
        <span className={`hd-gauge-pct hd-gauge-pct--${tone}`}>{pct}%</span>
      </span>
      <QuotaUsageCell window={shortWindow} />
      <QuotaResetCell window={shortWindow} now={now} />
      <QuotaUsageCell window={longWindow} />
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

  // Status gauges do not have a quota denominator. Treat nonzero observed usage
  // as noteworthy, but let any meaningfully-used quota window outrank it.
  return compactNumberValue(gauge.statusLabel) > 0 ? 0.01 : 0;
}

function isQuotaGauge(gauge: ServiceGauge): gauge is Extract<ServiceGauge, { kind: "quota" }> {
  return gauge.kind === "quota";
}

function topServiceGauges(gauges: ServiceGauge[]): ServiceGauge[] {
  return sortedServiceGauges(gauges)
    .slice(0, HOME_SERVICE_GAUGE_LIMIT);
}

function sortedServiceGauges(gauges: ServiceGauge[]): ServiceGauge[] {
  return gauges
    .map((gauge, index) => ({ gauge, index, score: gaugeUsageScore(gauge) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ gauge }) => gauge);
}

export default function HomeHero(props: HomeHeroProps) {
  const {
    now,
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
  } = props;
  const [showAllGauges, setShowAllGauges] = useState(false);

  const syncTone = error ? "err" : "ok";
  const subscriptionGauges = serviceGauges.filter(isQuotaGauge);
  const sortedGauges = sortedServiceGauges(subscriptionGauges);
  const compactGauges = topServiceGauges(subscriptionGauges);
  const gauges = showAllGauges ? sortedGauges : compactGauges;
  const hasHiddenGauges = subscriptionGauges.length > compactGauges.length;
  const showHeartrate = heartrate.reduce((total, bucket) => total + bucket.count, 0)
    >= heartrateVisibleEventThreshold;
  return (
    <section className="hd">
      {/* With no gauges the panel has no content of its own — only the freshness
          line — so it drops its frame rather than drawing an empty box. */}
      <div className={`hd-topbar${gauges.length > 0 ? "" : " hd-topbar--bare"}`}>
        {/* Route identity, operator and clock moved to the shell: they are the
            same on every surface, and the shell states them once. What stays is
            what this view owns — how fresh its own data is, and the control
            that refreshes it. */}
        <div className="hd-topbar-r">
          <span className={`hd-dot hd-dot--${syncTone}`} aria-hidden="true" />
          <span className={`hd-meta hd-meta--${syncTone}`}>{syncLabel}</span>
          <span className="hd-topbar-actions">
            <button
              type="button"
              className="hd-btn"
              disabled={loading || refreshing}
              onClick={onRefresh}
            >
              [{refreshing ? "refreshing" : "r refresh"}]
            </button>
          </span>
        </div>
        {gauges.length > 0 && (
          <div className="hd-topbar-c" aria-label="subscription usage">
            <div className="hd-gauge-title-row">
              <span className="hd-gauge-window">SUBSCRIPTIONS</span>
              {hasHiddenGauges && (
                <button
                  type="button"
                  className="hd-gauge-toggle"
                  aria-expanded={showAllGauges}
                  onClick={() => setShowAllGauges((value) => !value)}
                >
                  [{showAllGauges ? "top 2" : `all ${subscriptionGauges.length}`}]
                </button>
              )}
            </div>
            <div className="hd-gauge-set">
              <div className="hd-gauge-table-head" aria-hidden="true">
                <span>service</span>
                <span>short window</span>
                <span>resets</span>
                <span>long window</span>
                <span>resets in</span>
              </div>
              {gauges.map((g) => (
                <span key={g.id} className="hd-gauge-wrap">
                  <Gauge gauge={g} now={now} onClick={() => navigate({ view: "harnesses" })} />
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {showHeartrate && (
        <div className="hd-grid hd-grid--single">
          <div className="hd-panel hd-panel--hr">
            <div className="hd-panel-title">
              <span>HEART-RATE</span>
              <span className="hd-sep">·</span>
              <span>{heartrateWindow}</span>
              {heartrateBucketLabel ? (
                <>
                  <span className="hd-sep">·</span>
                  <span>{heartrateBucketLabel}</span>
                </>
              ) : null}
            </div>
            <HeartrateGraph buckets={heartrate} />
          </div>
        </div>
      )}
    </section>
  );
}
