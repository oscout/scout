import { ClipboardPaste, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  buildOrchestrationProviderMap,
  isQuotaSafe,
  orchestrationRuntimeRouteKey,
  orchestrationRuntimeRouteLabel,
  renderOrchestrationAskCommand,
} from "@openscout/protocol";
import type {
  OrchestrationModelGuidance,
  OrchestrationModelGuidanceStatus,
  OrchestrationProviderMap,
  OrchestrationRoleId,
  OrchestrationRoutingBias,
  OrchestrationRuntimeAssignment,
  OrchestrationRuntimeRoute,
  ProviderPacingSummary,
  ProviderUsageForMapping,
  QuotaPacingStatus,
} from "@openscout/protocol";

import { HarnessMark, harnessLabel as sharedHarnessLabel } from "../../components/HarnessMark.tsx";
import { api, peekApiGet } from "../../lib/api.ts";
import { routeMachineId } from "../../lib/router.ts";
import {
  formatAbsoluteTimestamp,
  normalizeTimestampMs,
  timeAgo,
} from "../../lib/time.ts";
import type { Route } from "../../lib/types.ts";
import { useScout } from "../../scout/Provider.tsx";
import { useContentOwnsSecondaryNav } from "../../scout/sidebar/useContentSecondaryNav.ts";
import type { ServiceGauge } from "../home/HomeHero.tsx";
import { OpsSubnav } from "../ops/OpsSubnav.tsx";
import "./harnesses-screen.css";

type QuotaGauge = Extract<ServiceGauge, { kind: "quota" }>;
type QuotaWindow = NonNullable<QuotaGauge["windows"]>[number];
type BudgetHistoryPoint = NonNullable<QuotaWindow["history"]>[number];
type ProviderView = "budget" | "routing";
type RoutingAngle = "tasks" | "models" | "cascades";
const ROUTE_CACHE_MAX_AGE_MS = 30_000;
const ROUTING_BIASES: Array<{
  value: OrchestrationRoutingBias;
  label: string;
}> = [
  { value: "capability", label: "Capability" },
  { value: "balanced", label: "Balanced" },
  { value: "quota", label: "Quota" },
];

type CloudAccount = {
  id: "cloudflare" | "vercel" | "exe";
  label: string;
  statusLabel: string;
  detailLabel: string;
};

type HarnessRow = {
  id: string;
  label: string;
  gauge: ServiceGauge | null;
};

const HARNESS_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  kimi: "Kimi",
  minimax: "MiniMax",
  cursor: "Cursor",
  native: "Native",
  worker: "Worker",
  bridge: "Bridge",
  http: "HTTP",
  pi: "Pi",
  flue: "Flue",
  github: "GitHub",
  unknown: "Unknown",
};

const SUBSCRIPTION_PROVIDERS = [
  {
    id: "claude",
    description: "Anthropic plan windows captured from Claude Code.",
    links: [
      { label: "Usage", href: "https://claude.ai/settings/usage" },
      { label: "Manage plan", href: "https://claude.ai/settings/billing" },
    ],
  },
  {
    id: "codex",
    description: "OpenAI plan windows reported by local Codex sessions.",
    links: [
      { label: "Usage", href: "https://chatgpt.com/codex/settings/usage" },
      { label: "Open Codex", href: "https://chatgpt.com/codex" },
    ],
  },
  {
    id: "kimi",
    description: "Kimi Code subscription windows and membership level.",
    links: [
      { label: "Kimi Code", href: "https://www.kimi.com/code" },
      { label: "Docs", href: "https://www.kimi.com/code/docs/en/" },
    ],
  },
  {
    id: "grok",
    description: "SuperGrok quota reported by local Grok, with dashboard capture and local activity as fallbacks.",
    links: [
      { label: "Open Grok", href: "https://grok.com/" },
      { label: "Billing", href: "https://grok.com/?_s=billing" },
      { label: "Help", href: "https://docs.x.ai/grok/faq" },
    ],
  },
  {
    id: "minimax",
    description: "MiniMax Token Plan 5-hour and weekly allowance.",
    links: [
      { label: "Usage", href: "https://platform.minimax.io/console/plan" },
      { label: "Docs", href: "https://platform.minimax.io/docs/token-plan/intro" },
    ],
  },
  {
    id: "cursor",
    description: "Cursor membership detected locally, plus usage totals from an exported dashboard capture.",
    links: [
      { label: "Usage", href: "https://cursor.com/dashboard/usage" },
      { label: "Manage plan", href: "https://cursor.com/dashboard/billing" },
    ],
  },
] as const;

const CLOUD_PROVIDER_LINKS: Record<CloudAccount["id"], Array<{ label: string; href: string }>> = {
  cloudflare: [
    { label: "Dashboard", href: "https://dash.cloudflare.com/" },
    { label: "Billing", href: "https://dash.cloudflare.com/?to=/:account/billing" },
  ],
  vercel: [
    { label: "Dashboard", href: "https://vercel.com/dashboard" },
    { label: "Billing", href: "https://vercel.com/account/billing" },
  ],
  exe: [
    { label: "VMs", href: "https://exe.dev/" },
    { label: "Billing", href: "https://exe.dev/user/billing" },
    { label: "Docs", href: "https://exe.dev/docs/what-is-exe" },
  ],
};

const CLOUD_PROVIDER_META: Record<CloudAccount["id"], { category: string; description: string }> = {
  exe: {
    category: "Agent compute",
    description: "Persistent VMs for remote Scout agents and isolated workloads.",
  },
  cloudflare: {
    category: "Edge platform",
    description: "Workers, networking, and edge infrastructure available for deployment.",
  },
  vercel: {
    category: "App hosting",
    description: "Projects, preview environments, and production deployments.",
  },
};

function CloudProviderMark({ provider }: { provider: CloudAccount["id"] }) {
  return (
    <span className={`hs-cloud-mark hs-cloud-mark--${provider}`} aria-hidden="true">
      {provider === "exe" ? (
        <img
          src="https://exe.dev/apple-touch-icon.png"
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ) : (
        <svg viewBox="0 0 24 24" focusable="false">
          {provider === "cloudflare" ? (
            <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268Zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />
          ) : (
            <path d="m12 1.608 12 20.784H0Z" />
          )}
        </svg>
      )}
    </span>
  );
}

function canonicalHarnessId(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("cursor")) return "cursor";
  if (normalized.includes("kimi") || normalized.includes("moonshot")) return "kimi";
  if (normalized.includes("minimax")) return "minimax";
  if (normalized.includes("github")) return "github";
  return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? sharedHarnessLabel(id);
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

function quotaWindows(gauge: QuotaGauge): QuotaWindow[] {
  return gauge.windows && gauge.windows.length > 0
    ? gauge.windows
    : [{
        label: formatLegacyQuotaLabel(gauge.unitLabel),
        fill: gauge.fill,
        usedLabel: gauge.usedLabel,
        capLabel: gauge.capLabel,
        unitLabel: gauge.unitLabel,
        resetAt: gauge.resetAt,
      }];
}

function usageLabel(window: QuotaWindow): string {
  if (window.capLabel === "100%" && window.usedLabel.endsWith("%")) return window.usedLabel;
  return `${window.usedLabel}/${window.capLabel}`;
}

function gaugeTone(fill: number): "ok" | "warn" | "err" {
  if (fill >= 0.9) return "err";
  if (fill >= 0.75) return "warn";
  return "ok";
}

function sampleHistory(points: BudgetHistoryPoint[] | undefined, limit = 30): BudgetHistoryPoint[] {
  const source = points ?? [];
  if (source.length <= limit) return source;
  if (limit <= 1) return [source[source.length - 1]!];
  const step = (source.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => source[Math.round(index * step)]!);
}

function formatResetRelative(resetAt: number): string {
  const rawDiffSec = Math.floor((resetAt - Date.now()) / 1000);
  const stale = rawDiffSec < 0;
  const diffSec = Math.abs(rawDiffSec);
  let label: string;
  if (diffSec >= 86400) {
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    label = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  } else if (diffSec >= 3600) {
    const hours = Math.floor(diffSec / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);
    label = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  } else {
    label = `${Math.max(1, Math.floor(diffSec / 60))}m`;
  }
  return stale ? `stale ${label}` : label;
}

function budgetLatestAt(gauge: ServiceGauge | null): number | null {
  if (!gauge) return null;
  const direct = normalizeTimestampMs(gauge.capturedAt);
  if (direct) return direct;
  if (gauge.kind !== "quota") return null;
  const windowCapture = quotaWindows(gauge).reduce<number | null>((latest, window) => {
    const capturedAt = normalizeTimestampMs(window.capturedAt);
    return Math.max(latest ?? 0, capturedAt ?? 0) || latest;
  }, null);
  if (windowCapture) return windowCapture;
  return quotaWindows(gauge)
    .flatMap((window) => window.history ?? [])
    .reduce<number | null>((latest, point) => {
      const capturedAt = normalizeTimestampMs(point.capturedAt);
      return Math.max(latest ?? 0, capturedAt ?? 0) || latest;
    }, null);
}

function DashboardCapture({
  provider,
  onImported,
}: {
  provider: "grok" | "cursor";
  onImported: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fieldId = `hs-${provider}-dashboard-capture`;
  const providerLabel = harnessLabel(provider);

  if (!open) {
    return (
      <button type="button" className="hs-dashboard-capture-trigger" onClick={() => setOpen(true)}>
        <ClipboardPaste size={12} aria-hidden="true" />
        Import dashboard
      </button>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await api<{ ok: true; gauge: ServiceGauge }>("/api/service-budgets/dashboard-import", {
        method: "POST",
        body: JSON.stringify({ provider, text }),
      });
      setText("");
      setMessage("Usage snapshot imported.");
      await onImported();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="hs-dashboard-capture" onSubmit={(event) => void submit(event)}>
      <label htmlFor={fieldId}>{providerLabel} usage snapshot</label>
      <p>
        {provider === "cursor"
          ? "Paste the exported Usage CSV or copied usage table."
          : "Copy the signed-in Usage panel and paste it here."}
        {" "}Scout keeps only normalized totals, not this text.
      </p>
      <textarea
        id={fieldId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={128 * 1024}
        rows={5}
        placeholder={provider === "cursor" ? "Date (UTC),Type,Model,Tokens,Cost…" : "Weekly SuperGrok… Limit · 12% used · Resets…"}
        aria-describedby={message ? `${fieldId}-message` : undefined}
      />
      {message ? <span id={`${fieldId}-message`} className="hs-dashboard-capture-message" role="status">{message}</span> : null}
      <div className="hs-dashboard-capture-actions">
        <button type="button" onClick={() => { setOpen(false); setMessage(null); }} disabled={submitting}>Cancel</button>
        <button type="submit" disabled={!text.trim() || submitting}>{submitting ? "Importing…" : "Use snapshot"}</button>
      </div>
    </form>
  );
}

function buildHarnessRows(gauges: ServiceGauge[]): HarnessRow[] {
  const gaugesById = new Map(gauges.map((gauge) => [canonicalHarnessId(gauge.id), gauge]));
  return SUBSCRIPTION_PROVIDERS.map(({ id }) => ({
    id,
    label: harnessLabel(id),
    gauge: gaugesById.get(id) ?? null,
  }));
}

function MiniHistory({ points }: { points?: BudgetHistoryPoint[] }) {
  const sampled = sampleHistory(points);
  if (sampled.length === 0) return <span className="hs-history hs-history-empty">live</span>;
  return (
    <span className="hs-history" aria-label={`${sampled.length} budget samples`}>
      {sampled.map((point, index) => {
        const fill = Math.max(0.06, Math.min(1, point.fill));
        return (
          <span
            key={`${point.capturedAt}:${index}`}
            className={`hs-history-bar hs-history-bar--${gaugeTone(point.fill)}`}
            style={{ height: `${Math.round(fill * 100)}%` }}
            title={`${formatAbsoluteTimestamp(point.capturedAt) || "unknown"} ${point.usedLabel}`}
          />
        );
      })}
    </span>
  );
}

function SubscriptionQuotaWindow({ gauge, window }: { gauge: QuotaGauge; window: QuotaWindow }) {
  const percentUsed = Math.max(0, Math.min(100, Math.round(window.fill * 100)));
  const percentRemaining = 100 - percentUsed;
  const tone = gaugeTone(window.fill);
  const resetDateTime = Number.isFinite(window.resetAt) ? new Date(window.resetAt).toISOString() : undefined;
  return (
    <div className="hs-subscription-window">
      <div className="hs-subscription-window-head">
        <div>
          <span className="hs-subscription-window-label">{window.label} window</span>
          <strong className={`hs-subscription-usage hs-subscription-usage--${tone}`}>
            {percentUsed}% used
          </strong>
        </div>
        <div className="hs-subscription-remaining">
          <strong>{percentRemaining}%</strong>
          <span>available</span>
        </div>
      </div>
      <div
        className="hs-subscription-meter"
        role="progressbar"
        aria-label={`${gauge.label} ${window.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentUsed}
      >
        <span className={`hs-subscription-meter-fill hs-subscription-meter-fill--${tone}`} style={{ width: `${percentUsed}%` }} />
      </div>
      <div className="hs-subscription-window-meta">
        <span>{usageLabel(window)} {window.unitLabel === "quota" ? "quota" : window.unitLabel}</span>
        <span>
          resets in {formatResetRelative(window.resetAt)}
          {resetDateTime ? (
            <time dateTime={resetDateTime} title={formatAbsoluteTimestamp(window.resetAt) || undefined}>
              {` · ${formatAbsoluteTimestamp(window.resetAt) || ""}`}
            </time>
          ) : null}
        </span>
      </div>
      <MiniHistory points={window.history} />
    </div>
  );
}

function SubscriptionLoadingState() {
  return (
    <div className="hs-subscription-loading" aria-hidden="true">
      <span className="hs-loading-line hs-loading-line--label" />
      <span className="hs-loading-line hs-loading-line--value" />
      <span className="hs-loading-meter" />
      <span className="hs-loading-line hs-loading-line--meta" />
      <span className="hs-loading-history" />
    </div>
  );
}

function orchestrationMapInput(
  gauges: ServiceGauge[],
  generatedAt: number,
  now: number,
): ProviderUsageForMapping {
  const providers = gauges.flatMap((gauge) => {
    if (gauge.kind !== "quota") return [];
    const windows = quotaWindows(gauge).map((window) => {
      const capturedAt = normalizeTimestampMs(window.capturedAt ?? gauge.capturedAt);
      const usedPercent = Math.round(Math.max(0, Math.min(1, window.fill)) * 1_000) / 10;
      return {
        label: window.label,
        usedPercent,
        percentRemaining: Math.round((100 - usedPercent) * 10) / 10,
        windowMs: window.windowMs ?? null,
        resetAt: normalizeTimestampMs(window.resetAt),
        resetIn: Number.isFinite(window.resetAt) ? formatResetRelative(window.resetAt) : "",
        freshness: {
          ageMs: capturedAt ? Math.max(0, now - capturedAt) : null,
          label: capturedAt ? timeAgo(capturedAt) || "now" : "unknown",
        },
      };
    });
    return [{
      id: canonicalHarnessId(gauge.id),
      label: harnessLabel(canonicalHarnessId(gauge.id)),
      plan: gauge.plan ?? null,
      windows,
    }];
  });
  return {
    generatedAt,
    generatedAtLocal: formatAbsoluteTimestamp(generatedAt) || "now",
    providers,
  };
}

function advisorPacingLabel(status: QuotaPacingStatus): string {
  switch (status) {
    case "underused": return "usage trails elapsed time";
    case "on_track": return "usage tracks elapsed time";
    case "ahead": return "usage exceeds elapsed time";
    default: return "pace unknown";
  }
}

function advisorAvailabilityTone(summary: ProviderPacingSummary): "ok" | "warn" | "err" | "dim" {
  if (summary.availability === "constrained") return "err";
  if (summary.availability === "guarded") return "warn";
  if (summary.availability === "unknown") return "dim";
  return "ok";
}

function advisorPacingTone(status: QuotaPacingStatus): "ok" | "warn" | "dim" {
  if (status === "ahead") return "warn";
  if (status === "unknown") return "dim";
  return "ok";
}

function advisorConfidenceTone(confidence: ProviderPacingSummary["confidence"]): "ok" | "warn" | "dim" {
  if (confidence === "stale") return "warn";
  if (confidence === "unknown") return "dim";
  return "ok";
}

function advisorRouteLabel(route: OrchestrationRuntimeRoute): string {
  return orchestrationRuntimeRouteLabel(route);
}

function CopyButton({ text, label = "Copy rule" }: { text: string; label?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [copyState]);
  const onCopy = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [text]);

  return (
    <button
      type="button"
      className="hs-advisor-dispatch-copy"
      onClick={() => void onCopy()}
      aria-live="polite"
      aria-atomic="true"
    >
      {copyState === "copied" ? "Copied!" : copyState === "failed" ? "Copy failed" : label}
    </button>
  );
}

function isQuotaSafeFallback(
  primary: { route: OrchestrationRuntimeRoute; quotaRisk: boolean },
  alternative: {
    route: OrchestrationRuntimeRoute;
    quotaRisk: boolean;
    quota: ProviderPacingSummary;
  } | undefined,
): boolean {
  return Boolean(
    primary.quotaRisk
    && alternative
    && !alternative.quotaRisk
    && isQuotaSafe(alternative.quota)
    && alternative.route.providerId !== primary.route.providerId,
  );
}

function advisorRemainingLabel(summary: ProviderPacingSummary): string {
  return summary.minimumRemainingPercent === null
    ? "quota unknown"
    : `${summary.minimumRemainingPercent}% minimum remaining`;
}

function modelGuidanceLabel(status: OrchestrationModelGuidanceStatus): string {
  switch (status) {
    case "use_now": return "Use now";
    case "available": return "Available";
    case "use_deliberately": return "Use deliberately";
    case "probe_first": return "Probe first";
    case "conserve": return "Conserve";
  }
}

function modelGuidanceTone(status: OrchestrationModelGuidanceStatus): "ok" | "warn" | "err" {
  if (status === "conserve") return "err";
  if (status === "probe_first" || status === "use_deliberately") return "warn";
  return "ok";
}




function AdvisorQuotaWindows({
  providerLabel,
  quota,
}: {
  providerLabel: string;
  quota: ProviderPacingSummary;
}) {
  if (quota.windows.length === 0) {
    return (
      <div className="hs-advisor-no-quota">
        <strong>No quota telemetry</strong>
        <span>Use one bounded ask as a canary before scaling this route.</span>
      </div>
    );
  }
  return (
    <div className="hs-advisor-windows">
      {quota.windows.map((window) => {
        const used = Math.max(0, Math.min(100, window.usedPercent));
        const elapsed = window.elapsedPercent === null ? null : Math.max(0, Math.min(100, window.elapsedPercent));
        const elapsedText = elapsed === null ? "elapsed time unavailable" : `${elapsed}% of the window elapsed`;
        const projectionText = window.projectedUsedPercent === null
          ? "projection unavailable"
          : `${window.projectedUsedPercent}% projected at reset`;
        return (
          <div key={window.label} className="hs-advisor-window">
            <div className="hs-advisor-window-head">
              <strong>{window.label}</strong>
              <span>{window.usedPercent}% used</span>
              <span>{advisorPacingLabel(window.status)}</span>
            </div>
            <div
              className="hs-advisor-window-meter"
              role="progressbar"
              aria-label={`${providerLabel} ${window.label} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(used)}
              aria-valuetext={`${window.usedPercent}% used; ${elapsedText}; ${projectionText}; ${advisorPacingLabel(window.status)}`}
            >
              <span className={`hs-advisor-window-fill hs-advisor-window-fill--${window.status}`} style={{ width: `${used}%` }} />
              {elapsed !== null ? (
                <span
                  className="hs-advisor-window-now"
                  style={{ left: `${elapsed}%` }}
                  title={`${elapsed}% of the window has elapsed`}
                  aria-hidden="true"
                />
              ) : null}
            </div>
            <div className="hs-advisor-window-meta">
              <span>{window.percentRemaining}% available</span>
              <span>{projectionText}</span>
              <span>{window.resetIn ? `resets in ${window.resetIn}` : "reset unknown"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AdvisorRoleRow({
  assignment,
  selected,
  onSelect,
}: {
  assignment: OrchestrationRuntimeAssignment;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="hs-advisor-role"
      data-selected={selected ? "true" : undefined}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="hs-advisor-role-mark">
        <HarnessMark harness={assignment.route.harness} size={25} title={null} />
      </span>
      <span className="hs-advisor-role-copy">
        <strong>{assignment.roleLabel}</strong>
        <span>{assignment.modelLabel}</span>
        <small>
          {assignment.route.profile ? `profile ${assignment.route.profile}` : assignment.route.harness} · Fit ${assignment.fit}
        </small>
      </span>
      <span className={`hs-advisor-role-tag ${assignment.quotaRisk ? "hs-advisor-role-tag--risk" : ""}`}>
        {assignment.quotaRisk
          ? `⚠️ ${assignment.quota.minimumRemainingPercent !== null ? `${assignment.quota.minimumRemainingPercent}%` : "Risk"}`
          : (assignment.fit >= 100 ? "Primary" : `Fit ${assignment.fit}`)}
      </span>
    </button>
  );
}

function TaskMappingAngle({ map }: { map: OrchestrationProviderMap }) {
  const [selectedRole, setSelectedRole] = useState<OrchestrationRoleId>("implementation");
  const selected = map.assignments.find((assignment) => assignment.role === selectedRole)
    ?? map.assignments[0];

  if (!selected) return null;
  const dispatchCommand = renderOrchestrationAskCommand(selected.route);
  const recommendedFallback = selected.alternatives.find((alternative) => (
    isQuotaSafeFallback(selected, alternative)
  ));

  return (
    <div className="hs-advisor-layout">
      <nav className="hs-advisor-roles" aria-label="Work roles">
        {map.assignments.map((assignment) => (
          <AdvisorRoleRow
            key={assignment.role}
            assignment={assignment}
            selected={assignment.role === selected.role}
            onSelect={() => setSelectedRole(assignment.role)}
          />
        ))}
      </nav>

      <article className="hs-advisor-detail" aria-live="polite">
        <header className="hs-advisor-detail-head">
          <div className="hs-advisor-model">
            <HarnessMark harness={selected.route.harness} size={26} title={null} />
            <div>
              <span>{selected.roleLabel} · Role Routing</span>
              <h4>{selected.modelLabel}</h4>
              <code>{advisorRouteLabel(selected.route)}</code>
            </div>
          </div>
          <span className={`hs-advisor-fit-badge ${selected.quotaRisk ? "hs-advisor-role-tag--risk" : ""}`}>
            {selected.quotaRisk ? "⚠️ Quota Risk · Failover Active" : `Primary Route · Fit ${selected.fit}`}
          </span>
        </header>

        {selected.quotaRisk ? (
          <div className="hs-advisor-quota-alert" role="alert">
            <div className="hs-advisor-quota-alert-head">
              <span className="hs-advisor-quota-alert-badge">⚠️ Quota Risk</span>
              <div>
                <strong>Quota Exhaustion Imminent · Elevated to Primary Concern</strong>
                <p>{selected.quotaRiskMessage ?? `${selected.quota.providerLabel} quota is near capacity.`}</p>
              </div>
            </div>
            <div className="hs-advisor-quota-alert-action">
              {recommendedFallback ? (
                <span>Failover to <strong>{recommendedFallback.label}</strong> to move work off the constrained provider.</span>
              ) : (
                <span>No quota-safe cross-provider fallback is currently available; keep the task bounded or wait for reset.</span>
              )}
            </div>
          </div>
        ) : null}

        <div className="hs-advisor-task-hero">
          <div className="hs-advisor-task-hero-head">
            <h5>Task Objective</h5>
            <span>Cognitive Strategy</span>
          </div>
          <p>{selected.objective}</p>
          <small><strong>Execution Rationale:</strong> {selected.taskRationale}</small>
        </div>

        <div className="hs-advisor-assessment">
          <section>
            <h5>Strengths for this task</h5>
            <p>{selected.capability}</p>
          </section>
          <section>
            <h5>Watchouts & Guardrails</h5>
            <p>{selected.caution}</p>
          </section>
        </div>

        <section className="hs-advisor-dispatch">
          <h5>Dispatch rule</h5>
          <div className="hs-advisor-dispatch-snippet">
            <code>{dispatchCommand}</code>
            <CopyButton text={dispatchCommand} label="Copy rule" />
          </div>
        </section>

        <section className="hs-advisor-ladder">
          <h5>Failover ladder</h5>
          <div className="hs-advisor-ladder-nodes">
            <div className={`hs-advisor-ladder-node ${selected.quotaRisk ? "hs-advisor-ladder-node--primary hs-advisor-ladder-node--risk" : "hs-advisor-ladder-node--primary"}`}>
              <span className="hs-advisor-ladder-badge">{selected.quotaRisk ? "⚠️ Primary (Quota Risk)" : "Primary"}</span>
              <div className="hs-advisor-ladder-body">
                <strong>{selected.modelLabel}</strong>
                <code>{advisorRouteLabel(selected.route)}</code>
                <small>
                  {selected.quotaRisk
                    ? `Exhaustion risk (${selected.quota.minimumRemainingPercent}% remaining) · ${selected.taskRationale}`
                    : `Initial execution target · ${selected.taskRationale}`}
                </small>
              </div>
            </div>
            {selected.alternatives.map((alt, idx) => {
              const quotaSafe = isQuotaSafeFallback(selected, alt);
              return (
                <div
                  key={orchestrationRuntimeRouteKey(alt.route)}
                  className={`hs-advisor-ladder-node ${quotaSafe ? "hs-advisor-ladder-node--fallback-rec" : ""}`}
                >
                  <span className="hs-advisor-ladder-badge">
                    {quotaSafe ? "⭐️ Quota-safe fallback" : (idx === 0 ? "Secondary" : "Tertiary")}
                  </span>
                  <div className="hs-advisor-ladder-body">
                    <strong>{alt.label}</strong>
                    <code>{advisorRouteLabel(alt.route)}</code>
                    <small>
                      {quotaSafe
                        ? `Moves work off ${selected.quota.providerLabel} · ${alt.taskRationale}`
                        : alt.quotaRisk
                          ? `Also quota constrained; use only if operationally necessary · ${alt.taskRationale}`
                          : `Fallback if ${selected.modelLabel} encounters rate limits or errors · ${alt.taskRationale}`}
                    </small>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="hs-advisor-quota-secondary">
          <div className="hs-advisor-quota-secondary-head">
            <h5>Provider Telemetry {selected.quotaRisk ? "(Active Constraint)" : "(Secondary)"}</h5>
            <span>{selected.quota.providerLabel}{selected.quota.plan ? ` · ${selected.quota.plan}` : ""}</span>
          </div>
          <div className="hs-advisor-quota-compact-bar">
            <span>Allowance: <strong>{advisorRemainingLabel(selected.quota)}</strong></span>
            <span>Pacing: <strong>{advisorPacingLabel(selected.quota.pacing)}</strong></span>
            <span>Telemetry: <strong>{selected.quota.confidence}</strong></span>
            {selected.quota.nextResetIn ? <span>Next reset: <strong>{selected.quota.nextResetIn}</strong></span> : null}
          </div>
          {selected.quotaRisk ? (
            <div style={{ marginTop: "var(--space-sm)" }}>
              <AdvisorQuotaWindows providerLabel={selected.quota.providerLabel} quota={selected.quota} />
            </div>
          ) : null}
        </section>
      </article>
    </div>
  );
}

function ModelGuideAngle({ models }: { models: OrchestrationModelGuidance[] }) {
  const defaultModel = models.find((model) => model.modelLabel === "GPT-5.6 Sol") ?? models[0];
  const [selectedRoute, setSelectedRoute] = useState(() => defaultModel ? orchestrationRuntimeRouteKey(defaultModel.route) : "");
  const selected = models.find((model) => orchestrationRuntimeRouteKey(model.route) === selectedRoute) ?? defaultModel;
  if (!selected) return null;
  const dispatchCommand = renderOrchestrationAskCommand(selected.route);

  return (
    <div className="hs-model-guide-layout">
      <nav className="hs-model-guide-list" aria-label="Model Fleet">
        {models.map((model) => {
          const route = orchestrationRuntimeRouteKey(model.route);
          return (
            <button
              key={route}
              type="button"
              className="hs-model-guide-item"
              data-selected={route === orchestrationRuntimeRouteKey(selected.route) ? "true" : undefined}
              aria-pressed={route === orchestrationRuntimeRouteKey(selected.route)}
              onClick={() => setSelectedRoute(route)}
            >
              <span className="hs-model-guide-mark">
                <HarnessMark harness={model.route.harness} size={23} title={null} />
              </span>
              <span className="hs-model-guide-item-copy">
                <strong>{model.modelLabel}</strong>
                <span>{model.quota.providerLabel} · {model.route.profile ? `profile ${model.route.profile}` : model.route.harness}</span>
              </span>
              <span className={`hs-advisor-role-tag ${model.quotaRisk ? "hs-advisor-role-tag--risk" : ""}`}>
                {model.quotaRisk ? "⚠️ Conserve" : modelGuidanceLabel(model.guidance)}
              </span>
            </button>
          );
        })}
      </nav>

      <article className="hs-model-guide-detail" aria-live="polite">
        <header className="hs-advisor-detail-head">
          <div className="hs-advisor-model">
            <HarnessMark harness={selected.route.harness} size={25} title={null} />
            <div>
              <span>{selected.quota.providerLabel}{selected.quota.plan ? ` · ${selected.quota.plan}` : ""}</span>
              <h4>{selected.modelLabel}</h4>
              <code>{advisorRouteLabel(selected.route)}</code>
            </div>
          </div>
          <span className={`hs-advisor-fit-badge ${selected.quotaRisk ? "hs-advisor-role-tag--risk" : ""}`}>
            {selected.quotaRisk ? "⚠️ Quota Risk · Conserve" : (selected.roles.length > 0 ? `${selected.roles.length} Assigned Roles` : "Model Fleet")}
          </span>
        </header>

        {selected.quotaRisk ? (
          <div className="hs-advisor-quota-alert" role="alert">
            <div className="hs-advisor-quota-alert-head">
              <span className="hs-advisor-quota-alert-badge">⚠️ Quota Risk</span>
              <div>
                <strong>High Quota Depletion · Conserve Model</strong>
                <p>{selected.quota.providerLabel} allowance is near capacity ({selected.quota.minimumRemainingPercent}% remaining). Conserve this model for essential high-fit tasks.</p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="hs-model-guide-roles">
          <strong>Assigned task roles</strong>
          <div className="hs-model-guide-role-chips">
            {selected.roles.map((role) => (
              <span key={role.role} className="hs-model-guide-role-chip">
                {role.label}
              </span>
            ))}
          </div>
        </div>

        <div className="hs-advisor-assessment">
          <section>
            <h5>Strengths & Cognitive Profile</h5>
            <p>{selected.strengths.join(" ")}</p>
          </section>
          <section>
            <h5>Watchouts & Guardrails</h5>
            <p>{selected.cautions.join(" ")}</p>
          </section>
        </div>

        <section className="hs-advisor-dispatch">
          <h5>Direct dispatch</h5>
          <div className="hs-advisor-dispatch-snippet">
            <code>{dispatchCommand}</code>
            <CopyButton text={dispatchCommand} label="Copy command" />
          </div>
        </section>

        <section className="hs-advisor-quota-secondary">
          <div className="hs-advisor-quota-secondary-head">
            <h5>Provider Telemetry {selected.quotaRisk ? "(Active Constraint)" : "(Secondary)"}</h5>
            <span>{selected.quota.providerLabel}{selected.quota.plan ? ` · ${selected.quota.plan}` : ""}</span>
          </div>
          <div className="hs-advisor-quota-compact-bar">
            <span>Allowance: <strong>{advisorRemainingLabel(selected.quota)}</strong></span>
            <span>Pacing: <strong>{advisorPacingLabel(selected.quota.pacing)}</strong></span>
            <span>Telemetry: <strong>{selected.quota.confidence}</strong></span>
            {selected.quota.nextResetIn ? <span>Next reset: <strong>{selected.quota.nextResetIn}</strong></span> : null}
          </div>
          {selected.quotaRisk ? (
            <div style={{ marginTop: "var(--space-sm)" }}>
              <AdvisorQuotaWindows providerLabel={selected.quota.providerLabel} quota={selected.quota} />
            </div>
          ) : null}
        </section>
      </article>
    </div>
  );
}

function CascadesAngle({ assignments }: { assignments: OrchestrationRuntimeAssignment[] }) {
  const [selectedRole, setSelectedRole] = useState<OrchestrationRoleId>("implementation");
  const [customOrders, setCustomOrders] = useState<Partial<Record<OrchestrationRoleId, string[]>>>({});
  const selected = assignments.find((assignment) => assignment.role === selectedRole) ?? assignments[0];
  if (!selected) return null;

  const baseSteps = [
    {
      label: selected.modelLabel,
      route: selected.route,
      capability: selected.capability,
      taskRationale: selected.taskRationale,
      quota: selected.quota,
      quotaRisk: selected.quotaRisk,
    },
    ...selected.alternatives.map((alternative) => ({
      label: alternative.label,
      route: alternative.route,
      capability: alternative.capability,
      taskRationale: alternative.taskRationale,
      quota: alternative.quota,
      quotaRisk: alternative.quotaRisk,
    })),
  ];
  const customOrder = customOrders[selected.role];
  const orderedSteps = customOrder
    ? customOrder.flatMap((route) => {
        const step = baseSteps.find((candidate) => orchestrationRuntimeRouteKey(candidate.route) === route);
        return step ? [step] : [];
      })
    : baseSteps;
  const promote = (route: string) => {
    const routes = orderedSteps.map((step) => orchestrationRuntimeRouteKey(step.route));
    setCustomOrders((current) => ({
      ...current,
      [selected.role]: [route, ...routes.filter((candidate) => candidate !== route)],
    }));
  };

  const cascadeCommand = renderOrchestrationAskCommand(orderedSteps[0].route);

  return (
    <div className="hs-cascade-layout">
      <nav className="hs-advisor-roles" aria-label="Cascade roles">
        {assignments.map((assignment) => (
          <AdvisorRoleRow
            key={assignment.role}
            assignment={assignment}
            selected={assignment.role === selected.role}
            onSelect={() => setSelectedRole(assignment.role)}
          />
        ))}
      </nav>

      <article className="hs-cascade-editor">
        <header>
          <div>
            <span>{selected.roleLabel} · Failover Hierarchy</span>
            <h4>Task Escalation Sequence</h4>
            <p>Hierarchical fallback sequence when models encounter rate limits, timeouts, or task complexity thresholds.</p>
          </div>
          {customOrder ? (
            <button
              type="button"
              onClick={() => setCustomOrders((current) => {
                const next = { ...current };
                delete next[selected.role];
                return next;
              })}
            >
              Reset suggested order
            </button>
          ) : (
            <span>Default policy</span>
          )}
        </header>

        <ol className="hs-cascade-workflow">
          {orderedSteps.map((step, index) => {
            const route = orchestrationRuntimeRouteKey(step.route);
            const quotaSafe = index > 0 && isQuotaSafeFallback(orderedSteps[0], step);
            const rank = index === 0 ? "Primary Route" : index === 1 ? "Secondary Fallback" : "Tertiary Fallback";
            const condition = index === 0
              ? (step.quotaRisk
                  ? `Initial target (⚠️ Quota Risk: ${step.quota.minimumRemainingPercent}% remaining) · ${step.taskRationale}`
                  : `Initial execution target · ${step.taskRationale}`)
              : index === 1
                ? (quotaSafe
                    ? `⭐️ Quota-safe route off ${orderedSteps[0].quota.providerLabel} · ${step.taskRationale}`
                    : `Triggered if primary encounters rate limits, errors, or complexity threshold · ${step.taskRationale}`)
                : `Emergency baseline fallback · ${step.taskRationale}`;
            return (
              <li key={`${selected.role}:${route}`} className="hs-cascade-node">
                <span className="hs-cascade-node-index">{index + 1}</span>
                <div className="hs-cascade-node-main">
                  <span>{rank}</span>
                  <strong>{step.label}</strong>
                  <code>{advisorRouteLabel(step.route)}</code>
                  <p>{step.capability}</p>
                  <small>{condition}</small>
                </div>
                <div className="hs-cascade-node-side">
                  <em className={step.quotaRisk ? "hs-advisor-tone--warn" : ""}>
                    {step.quota.minimumRemainingPercent === null
                      ? "quota unknown"
                      : `${step.quota.minimumRemainingPercent}% quota remaining`}
                  </em>
                  {index > 0 ? (
                    <button type="button" onClick={() => promote(route)}>Make primary</button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>

        <section className="hs-advisor-dispatch">
          <h5>Primary dispatch command</h5>
          <div className="hs-advisor-dispatch-snippet">
            <code>{cascadeCommand}</code>
            <CopyButton text={cascadeCommand} label="Copy primary command" />
          </div>
        </section>
      </article>
    </div>
  );
}

function OrchestratorMap({
  map,
  loading,
  bias,
  onBiasChange,
}: {
  map: OrchestrationProviderMap;
  loading: boolean;
  bias: OrchestrationRoutingBias;
  onBiasChange: (bias: OrchestrationRoutingBias) => void;
}) {
  const [angle, setAngle] = useState<RoutingAngle>("tasks");
  const angleCopy: Record<RoutingAngle, string> = {
    tasks: "Task-first model routing: Map each role to the optimal cognitive profile and failover ladder.",
    models: "Model fleet inventory: Inspect cognitive strengths, guardrails, and assigned roles across all models.",
    cascades: "Failover & escalation rules: Review and customize the task escalation sequence for each role.",
  };

  return (
    <section className="hs-advisor" aria-labelledby="hs-orchestrator-map-title" aria-busy={loading}>
      <div className="hs-section-head hs-advisor-head">
        <div>
          <h3 id="hs-orchestrator-map-title">Orchestrator map</h3>
          <p>{angleCopy[angle]}</p>
        </div>
        <div className="hs-advisor-head-tools">
          <span className="hs-section-meta">{loading ? "refreshing inputs" : "advisory · no dispatch"}</span>
          <label className="hs-routing-bias">
            <span>Routing bias</span>
            <input
              type="range"
              min={0}
              max={ROUTING_BIASES.length - 1}
              step={1}
              value={ROUTING_BIASES.findIndex((option) => option.value === bias)}
              aria-valuetext={ROUTING_BIASES.find((option) => option.value === bias)?.label}
              onChange={(event) => {
                const option = ROUTING_BIASES[Number(event.target.value)];
                if (option) onBiasChange(option.value);
              }}
            />
            <small aria-hidden="true">
              {ROUTING_BIASES.map((option) => (
                <i key={option.value} data-active={option.value === bias ? "true" : undefined}>{option.label}</i>
              ))}
            </small>
          </label>
        </div>
      </div>

      <div className="hs-routing-angles" role="group" aria-label="Orchestrator map angle">
        {([
          ["tasks", "Task map"],
          ["models", "Model fleet"],
          ["cascades", "Cascades"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={angle === value}
            onClick={() => setAngle(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {angle === "tasks" ? <TaskMappingAngle map={map} /> : null}
      {angle === "models" ? <ModelGuideAngle models={map.models} /> : null}
      {angle === "cascades" ? <CascadesAngle assignments={map.assignments} /> : null}
    </section>
  );
}
function SubscriptionSection({ rows, loading, onImported }: { rows: HarnessRow[]; loading: boolean; onImported: () => Promise<void> }) {
  const subscriptions = SUBSCRIPTION_PROVIDERS.map((provider) => ({
    provider,
    row: rows.find((row) => row.id === provider.id) ?? null,
  }));
  const connected = subscriptions.filter(({ row }) => row?.gauge).length;
  const usageFeeds = subscriptions.filter(({ row }) => row?.gauge?.kind === "quota").length;
  const knownPlans = subscriptions.filter(({ row }) => row?.gauge?.kind === "quota" && row.gauge.plan
    || row?.gauge?.kind === "status").length;
  const nextReset = subscriptions
    .flatMap(({ row }) => row?.gauge?.kind === "quota" ? quotaWindows(row.gauge) : [])
    .map((window) => window.resetAt)
    .filter((resetAt) => resetAt > Date.now())
    .sort((left, right) => left - right)[0];

  return (
    <section className="hs-subscriptions" aria-labelledby="hs-subscriptions-title" aria-busy={loading}>
      <div className="hs-section-head hs-subscriptions-head">
        <div>
          <h3 id="hs-subscriptions-title">Subscriptions</h3>
          <p>Plans, remaining allowance, reset windows, and the fastest path to each provider dashboard.</p>
        </div>
        <div className="hs-subscription-summary" aria-label="Subscription feed summary">
          <span><strong>{loading ? "—" : connected}</strong> detected</span>
          <span><strong>{loading ? "—" : usageFeeds}</strong> usage feeds</span>
          <span><strong>{loading ? "—" : knownPlans}</strong> plans named</span>
          <span><strong>{loading ? "—" : nextReset ? formatResetRelative(nextReset) : "-"}</strong> next reset</span>
        </div>
      </div>

      <div className="hs-subscription-grid">
        {subscriptions.map(({ provider, row }) => {
          const gauge = row?.gauge ?? null;
          const pending = loading && !gauge;
          const cardState = pending ? "loading" : gauge ? "connected" : "missing";
          const plan = gauge?.kind === "quota" ? gauge.plan : gauge?.kind === "status" ? gauge.statusLabel : null;
          const latestAt = budgetLatestAt(gauge);
          const connectionLabel = gauge?.kind === "quota"
            ? "Usage connected"
            : gauge?.kind === "status"
              ? gauge.detailLabel || "Subscription detected"
              : pending ? "Checking" : "Not detected";
          return (
            <article key={provider.id} className={`hs-subscription-card hs-subscription-card--${cardState}`}>
              <header className="hs-subscription-card-head">
                <div className="hs-subscription-provider">
                  <HarnessMark harness={provider.id} size={18} title={null} className="hs-subscription-mark" />
                  <div>
                    <h4>{harnessLabel(provider.id)}</h4>
                    <span>{pending ? "Checking local plan…" : plan || "Plan not reported"}</span>
                  </div>
                </div>
                <span className={`hs-subscription-state hs-subscription-state--${cardState}`}>
                  {connectionLabel}
                </span>
              </header>

              <p className="hs-subscription-description">{provider.description}</p>

              {pending ? (
                <SubscriptionLoadingState />
              ) : gauge?.kind === "quota" ? (
                <div className="hs-subscription-windows">
                  {quotaWindows(gauge).map((window) => (
                    <SubscriptionQuotaWindow key={`${provider.id}:${window.label}`} gauge={gauge} window={window} />
                  ))}
                </div>
              ) : gauge?.kind === "status" ? (
                <div className="hs-subscription-status-detail">
                  <strong>{gauge.statusLabel}</strong>
                  <span>{gauge.detailLabel || "Subscription detected locally. Open the provider dashboard for live usage."}</span>
                </div>
              ) : (
                <div className="hs-subscription-missing">
                  <strong>No local subscription feed yet</strong>
                  <span>Open the provider locally, then refresh Scout.</span>
                </div>
              )}

              {provider.id === "cursor" || (provider.id === "grok" && gauge?.kind !== "quota") ? (
                <DashboardCapture provider={provider.id} onImported={onImported} />
              ) : null}

              <footer className="hs-subscription-footer">
                <span>
                  {pending ? "checking local feed" : latestAt ? `updated ${timeAgo(latestAt) || "now"}` : gauge ? "detected locally" : "waiting for provider data"}
                  {gauge?.source ? ` · ${gauge.source}` : ""}
                </span>
                <nav aria-label={`${harnessLabel(provider.id)} quick links`}>
                  {provider.links.map((link) => (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
                      {link.label}
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  ))}
                </nav>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CloudAccountsSection({ accounts, loading }: { accounts: CloudAccount[]; loading: boolean }) {
  if (accounts.length === 0 && !loading) return null;
  return (
    <section className="hs-cloud-accounts" aria-labelledby="hs-cloud-accounts-title" aria-busy={loading}>
      <div className="hs-section-head hs-cloud-accounts-head">
        <div>
          <h3 id="hs-cloud-accounts-title">Cloud accounts</h3>
          <p>Infrastructure available to Scout for deployment and agent compute.</p>
        </div>
        <span className="hs-section-meta">{loading ? "checking accounts" : `${accounts.length} connected`}</span>
      </div>
      <div className="hs-cloud-grid">
        {loading && accounts.length === 0 ? Array.from({ length: 3 }, (_, index) => (
          <article key={index} className="hs-cloud-card hs-cloud-card--loading" aria-hidden="true">
            <header className="hs-cloud-card-head">
              <span className="hs-loading-mark" />
              <span className="hs-loading-line hs-loading-line--cloud-title" />
            </header>
            <span className="hs-loading-line hs-loading-line--cloud-copy" />
            <footer className="hs-cloud-card-footer">
              <span className="hs-loading-line hs-loading-line--cloud-meta" />
              <span className="hs-loading-actions" />
            </footer>
          </article>
        )) : null}
        {accounts.map((account) => {
          const meta = CLOUD_PROVIDER_META[account.id];
          return (
            <article key={account.id} className="hs-cloud-card">
              <header className="hs-cloud-card-head">
                <div className="hs-cloud-identity">
                  <CloudProviderMark provider={account.id} />
                  <div>
                    <span className="hs-cloud-category">{meta.category}</span>
                    <h4>{account.label}</h4>
                  </div>
                </div>
                <span className="hs-subscription-state hs-subscription-state--connected">{account.statusLabel}</span>
              </header>
              <p className="hs-cloud-description">{meta.description}</p>
              <footer className="hs-cloud-card-footer">
                <span className="hs-cloud-connection">
                  <span className="hs-cloud-dot" aria-hidden="true" />
                  {account.detailLabel}
                </span>
                <nav aria-label={`${account.label} quick links`}>
                  {CLOUD_PROVIDER_LINKS[account.id].map((link) => (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
                      {link.label}
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  ))}
                </nav>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function HarnessesScreen({ navigate }: { navigate: (r: Route) => void }) {
  const { route } = useScout();
  const machineId = routeMachineId(route);
  // Warm start: paint the last budgets response on remount; the mount effect
  // still refetches (and then forces ?refresh=1) in the background.
  const [initialBudgets] = useState(() =>
    peekApiGet<{ generatedAt?: number; gauges: ServiceGauge[]; cloudAccounts?: CloudAccount[] }>(
      "/api/service-budgets",
      ROUTE_CACHE_MAX_AGE_MS,
    ),
  );
  const [serviceGauges, setServiceGauges] = useState<ServiceGauge[]>(initialBudgets?.gauges ?? []);
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccount[]>(initialBudgets?.cloudAccounts ?? []);
  const [providerView, setProviderView] = useState<ProviderView>("budget");
  const [budgetGeneratedAt, setBudgetGeneratedAt] = useState(
    () => normalizeTimestampMs(initialBudgets?.generatedAt) ?? Date.now(),
  );
  const [routingBias, setRoutingBias] = useState<OrchestrationRoutingBias>("balanced");
  const [loading, setLoading] = useState(initialBudgets === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const hasBudgetsRef = useRef(initialBudgets !== null);

  const load = useCallback(async (force = false, initial = false) => {
    const requestId = ++requestIdRef.current;
    if (initial && !hasBudgetsRef.current) setLoading(true);
    setRefreshing(true);
    setError(null);

    try {
      const response = await api<{ generatedAt?: number; gauges: ServiceGauge[]; cloudAccounts?: CloudAccount[] }>(
        `/api/service-budgets${force ? "?refresh=1" : ""}`,
      );
      if (requestId !== requestIdRef.current) return;
      hasBudgetsRef.current = true;
      setServiceGauges(response.gauges ?? []);
      setBudgetGeneratedAt(normalizeTimestampMs(response.generatedAt) ?? Date.now());
      setCloudAccounts(response.cloudAccounts ?? []);
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let refreshId: number | undefined;
    void load(false, true).then(() => {
      if (cancelled) return;
      refreshId = window.setTimeout(() => void load(true), 600);
    });
    return () => {
      cancelled = true;
      if (refreshId !== undefined) window.clearTimeout(refreshId);
    };
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => void load(false), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const rows = useMemo(() => buildHarnessRows(serviceGauges), [serviceGauges]);
  const orchestrationMap = useMemo(() => {
    const now = Date.now();
    return buildOrchestrationProviderMap(
      orchestrationMapInput(serviceGauges, budgetGeneratedAt, now),
      { now, bias: routingBias },
    );
  }, [budgetGeneratedAt, routingBias, serviceGauges]);

  const contentOwnsSecondaryNav = useContentOwnsSecondaryNav();

  return (
    <div className="s-ops">
      {contentOwnsSecondaryNav ? (
        <div className="s-ops-header">
          <OpsSubnav activeRoute={{ view: "harnesses", ...(machineId ? { machineId } : {}) }} navigate={navigate} />
        </div>
      ) : null}
      <div className="s-ops-body hs-body">
        <div className="hs-page">
          <header className="hs-page-head">
            <div className="hs-title-group">
              <span className="hs-kicker">ops / provider central</span>
              <h2>Agent Providers</h2>
              <p>
                {providerView === "budget"
                  ? "See what you pay for, how much remains, and where to use it."
                  : "Map each kind of work to a model and provider route using live quota posture."}
              </p>
            </div>
            <div className="hs-page-actions">
              <div className="hs-view-switch" role="group" aria-label="Provider view">
                <button
                  type="button"
                  aria-pressed={providerView === "budget"}
                  onClick={() => setProviderView("budget")}
                >
                  Budget
                </button>
                <button
                  type="button"
                  aria-pressed={providerView === "routing"}
                  onClick={() => setProviderView("routing")}
                >
                  Routing
                </button>
              </div>
              <button
                type="button"
                className="hs-refresh"
                disabled={refreshing}
                onClick={() => void load(true)}
              >
                <RefreshCw size={14} className={refreshing ? "hs-refresh-icon-spinning" : ""} aria-hidden="true" />
                <span>{refreshing ? "Refreshing" : "Refresh"}</span>
              </button>
            </div>
          </header>

          {error && <div className="hs-error" role="status" aria-live="polite">refresh: {error}</div>}
          {providerView === "budget" ? (
            <div id="hs-budget-view" className="hs-provider-view">
              <SubscriptionSection rows={rows} loading={loading} onImported={() => load(false)} />
              <CloudAccountsSection accounts={cloudAccounts} loading={loading} />
            </div>
          ) : (
            <div id="hs-routing-view" className="hs-provider-view">
              <OrchestratorMap
                map={orchestrationMap}
                loading={loading}
                bias={routingBias}
                onBiasChange={setRoutingBias}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
