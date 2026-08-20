import { ClipboardPaste, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { HarnessMark, harnessLabel as sharedHarnessLabel } from "../../components/HarnessMark.tsx";
import { api } from "../../lib/api.ts";
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
  const [serviceGauges, setServiceGauges] = useState<ServiceGauge[]>([]);
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (force = false, initial = false) => {
    const requestId = ++requestIdRef.current;
    if (initial) setLoading(true);
    setRefreshing(true);
    setError(null);

    try {
      const response = await api<{ gauges: ServiceGauge[]; cloudAccounts?: CloudAccount[] }>(
        `/api/service-budgets${force ? "?refresh=1" : ""}`,
      );
      if (requestId !== requestIdRef.current) return;
      setServiceGauges(response.gauges ?? []);
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
              <p>See what you pay for, how much remains, and where to use it.</p>
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
          </header>

          {error && <div className="hs-error" role="status" aria-live="polite">refresh: {error}</div>}
          <SubscriptionSection rows={rows} loading={loading} onImported={() => load(false)} />
          <CloudAccountsSection accounts={cloudAccounts} loading={loading} />
        </div>
      </div>
    </div>
  );
}
