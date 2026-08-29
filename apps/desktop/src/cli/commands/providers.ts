import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { readScoutWebJson } from "../web-api.ts";
import {
  buildOrchestrationProviderMap,
  isOrchestrationRoleId,
  ORCHESTRATION_ROLE_IDS,
  renderOrchestrationProviderMap,
} from "@openscout/protocol";
import type { OrchestrationRoleId } from "@openscout/protocol";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  github: "GitHub",
  grok: "Grok",
  kimi: "Kimi",
  minimax: "MiniMax",
};

type ServiceQuotaWindowPayload = {
  label?: unknown;
  fill?: unknown;
  usedLabel?: unknown;
  capLabel?: unknown;
  unitLabel?: unknown;
  resetAt?: unknown;
  windowMs?: unknown;
  capturedAt?: unknown;
  source?: unknown;
};

type ServiceGaugePayload = {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  fill?: unknown;
  usedLabel?: unknown;
  capLabel?: unknown;
  unitLabel?: unknown;
  resetAt?: unknown;
  windows?: unknown;
  plan?: unknown;
  capturedAt?: unknown;
  source?: unknown;
};

export type ServiceBudgetsPayload = {
  generatedAt?: unknown;
  gauges?: unknown;
};

export type ProviderUsageFreshness = {
  capturedAt: number | null;
  capturedAtIso: string | null;
  ageMs: number | null;
  label: string;
};

export type ProviderUsageWindow = {
  label: string;
  usedPercent: number;
  percentRemaining: number;
  windowMs: number | null;
  resetAt: number | null;
  resetAtIso: string | null;
  resetAtLocal: string;
  resetIn: string;
  source: string;
  freshness: ProviderUsageFreshness;
};

export type ProviderUsageProvider = {
  id: string;
  label: string;
  plan: string | null;
  windows: ProviderUsageWindow[];
};

export type ProviderUsageReport = {
  generatedAt: number;
  generatedAtIso: string;
  generatedAtLocal: string;
  providers: ProviderUsageProvider[];
};

export type ProvidersCommandOptions =
  | { command: "help" }
  | { command: "usage"; forceRefresh: boolean }
  | { command: "map"; forceRefresh: boolean; role: OrchestrationRoleId | null };

export type ProviderUsageFormatOptions = {
  now?: number;
  locale?: string | string[];
  timeZone?: string;
};

export type ProvidersCommandDependencies = ProviderUsageFormatOptions & {
  readJson?: typeof readScoutWebJson;
};

export function renderProvidersCommandHelp(): string {
  return [
    "Usage:",
    "  scout providers usage [--refresh | --cached] [--json]",
    "  scout providers map [--refresh | --cached] [--role <role>] [--json]",
    "",
    "Show provider quota windows or build a quota-aware orchestration map.",
    "",
    "The usage view prints percent used, percent remaining, local reset time,",
    "source, and freshness for every provider quota window. The map combines",
    "those windows with a small role/model/provider policy; it recommends dispatches",
    "but does not create durable `scout role` assignments.",
    "",
    `Map roles: ${ORCHESTRATION_ROLE_IDS.join(", ")}`,
    "",
    "Options:",
    "  --refresh       Force live provider reads (default).",
    "  --cached        Allow the service-budget cache; do not force a refresh.",
    "  --role <role>   Limit the orchestration map to one role.",
    "  --json          Emit structured JSON (global Scout flag).",
    "",
    "Examples:",
    "  scout providers usage",
    "  scout providers map",
    "  scout providers map --role implementation --cached",
  ].join("\n");
}

export function parseProvidersCommandOptions(args: string[]): ProvidersCommandOptions {
  const action = args[0];
  if (!action || HELP_FLAGS.has(action)) return { command: "help" };
  if (action !== "usage" && action !== "map") {
    throw new ScoutCliError(`unknown providers action: ${action} (try: scout providers usage or scout providers map)`);
  }
  if (args.slice(1).some((arg) => HELP_FLAGS.has(arg))) return { command: "help" };

  let forceRefresh = true;
  let refreshMode: "refresh" | "cached" | null = null;
  let role: OrchestrationRoleId | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--refresh" || arg === "--cached") {
      const nextMode = arg === "--refresh" ? "refresh" : "cached";
      if (refreshMode && refreshMode !== nextMode) {
        throw new ScoutCliError(`providers ${action} accepts only one of --refresh or --cached`);
      }
      refreshMode = nextMode;
      forceRefresh = nextMode === "refresh";
      continue;
    }
    if (arg === "--role") {
      if (action !== "map") {
        throw new ScoutCliError("providers usage does not accept --role");
      }
      const nextRole = args[index + 1];
      if (!nextRole || !isOrchestrationRoleId(nextRole)) {
        throw new ScoutCliError(`providers map --role must be one of: ${ORCHESTRATION_ROLE_IDS.join(", ")}`);
      }
      role = nextRole;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ScoutCliError(`unknown providers ${action} option: ${arg}`);
    }
    throw new ScoutCliError(`unexpected providers ${action} argument: ${arg}`);
  }
  return action === "usage"
    ? { command: "usage", forceRefresh }
    : { command: "map", forceRefresh, role };
}

export async function runProvidersCommand(
  context: ScoutCommandContext,
  args: string[],
  dependencies: ProvidersCommandDependencies = {},
): Promise<void> {
  const options = parseProvidersCommandOptions(args);
  if (options.command === "help") {
    context.output.writeText(renderProvidersCommandHelp());
    return;
  }

  const path = `/api/service-budgets${options.forceRefresh ? "?refresh=1" : ""}`;
  const payload = await (dependencies.readJson ?? readScoutWebJson)<ServiceBudgetsPayload>(context, path);
  const report = buildProviderUsageReport(payload, dependencies);
  if (options.command === "usage") {
    context.output.writeValue(report, renderProviderUsageReport);
    return;
  }
  const map = buildOrchestrationProviderMap(report, {
    now: finiteNumber(dependencies.now) ?? undefined,
    role: options.role,
  });
  context.output.writeValue(map, renderOrchestrationProviderMap);
}

export function buildProviderUsageReport(
  payload: ServiceBudgetsPayload,
  options: ProviderUsageFormatOptions = {},
): ProviderUsageReport {
  const now = finiteNumber(options.now) ?? Date.now();
  const generatedAt = finiteNumber(payload.generatedAt) ?? now;
  const gauges = Array.isArray(payload.gauges) ? payload.gauges : [];
  const providers = gauges
    .filter(isRecord)
    .map((gauge) => usageProviderFromGauge(gauge as ServiceGaugePayload, now, options))
    .filter((provider): provider is ProviderUsageProvider => provider !== null);

  return {
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    generatedAtLocal: formatLocalTimestamp(generatedAt, now, options),
    providers,
  };
}

export function renderProviderUsageReport(report: ProviderUsageReport): string {
  const windowCount = report.providers.reduce((count, provider) => count + provider.windows.length, 0);
  const lines = [
    `Provider usage · ${windowCount} ${windowCount === 1 ? "window" : "windows"} · generated ${report.generatedAtLocal}`,
  ];

  if (windowCount === 0) {
    lines.push("", "No provider quota windows are currently available.");
    lines.push("Open a local provider session, then run `scout providers usage --refresh`.");
    return lines.join("\n");
  }

  for (const provider of report.providers) {
    lines.push("", `${provider.label}${provider.plan ? ` · ${provider.plan}` : ""}`);
    for (const window of provider.windows) {
      lines.push(
        `  ${window.label}  ${formatPercent(window.usedPercent)} used · ${formatPercent(window.percentRemaining)} remaining · resets ${window.resetAtLocal}${window.resetIn ? ` (${window.resetIn})` : ""}`,
      );
      lines.push(`      ${window.source} · updated ${window.freshness.label}`);
    }
  }

  return lines.join("\n");
}

function usageProviderFromGauge(
  gauge: ServiceGaugePayload,
  now: number,
  options: ProviderUsageFormatOptions,
): ProviderUsageProvider | null {
  if (gauge.kind !== "quota") return null;

  const id = stringValue(gauge.id) ?? stringValue(gauge.label) ?? "unknown";
  const windows = quotaWindowsFromGauge(gauge)
    .map((window) => usageWindowFromPayload(window, gauge, now, options))
    .filter((window): window is ProviderUsageWindow => window !== null);
  if (windows.length === 0) return null;

  return {
    id,
    label: providerLabel(id, stringValue(gauge.label)),
    plan: stringValue(gauge.plan) ?? null,
    windows,
  };
}

function quotaWindowsFromGauge(gauge: ServiceGaugePayload): ServiceQuotaWindowPayload[] {
  if (Array.isArray(gauge.windows)) {
    const windows = gauge.windows.filter(isRecord) as ServiceQuotaWindowPayload[];
    if (windows.length > 0) return windows;
  }

  return [{
    label: legacyWindowLabel(stringValue(gauge.unitLabel)),
    fill: gauge.fill,
    usedLabel: gauge.usedLabel,
    capLabel: gauge.capLabel,
    unitLabel: gauge.unitLabel,
    resetAt: gauge.resetAt,
    capturedAt: gauge.capturedAt,
    source: gauge.source,
  }];
}

function usageWindowFromPayload(
  window: ServiceQuotaWindowPayload,
  gauge: ServiceGaugePayload,
  now: number,
  options: ProviderUsageFormatOptions,
): ProviderUsageWindow | null {
  const usedPercent = percentFromWindow(window);
  if (usedPercent === null) return null;

  const resetAt = finiteNumber(window.resetAt) ?? finiteNumber(gauge.resetAt) ?? null;
  const capturedAt = finiteNumber(window.capturedAt) ?? finiteNumber(gauge.capturedAt) ?? null;
  const source = stringValue(window.source) ?? stringValue(gauge.source) ?? "provider report";

  return {
    label: stringValue(window.label) ?? legacyWindowLabel(stringValue(window.unitLabel)),
    usedPercent,
    percentRemaining: roundPercent(100 - usedPercent),
    windowMs: finiteNumber(window.windowMs),
    resetAt,
    resetAtIso: resetAt === null ? null : new Date(resetAt).toISOString(),
    resetAtLocal: resetAt === null ? "unknown" : formatLocalTimestamp(resetAt, now, options),
    resetIn: resetAt === null ? "" : formatRelativeTime(resetAt - now),
    source,
    freshness: freshnessFromCapturedAt(capturedAt, now),
  };
}

function percentFromWindow(window: ServiceQuotaWindowPayload): number | null {
  const fill = finiteNumber(window.fill);
  if (fill !== null) return roundPercent(Math.max(0, Math.min(1, fill)) * 100);

  const usedLabel = stringValue(window.usedLabel);
  const match = usedLabel?.match(/^(-?\d+(?:\.\d+)?)%$/u);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent)
    ? roundPercent(Math.max(0, Math.min(100, percent)))
    : null;
}

function freshnessFromCapturedAt(capturedAt: number | null, now: number): ProviderUsageFreshness {
  if (capturedAt === null) {
    return { capturedAt: null, capturedAtIso: null, ageMs: null, label: "unknown" };
  }
  const ageMs = Math.max(0, now - capturedAt);
  return {
    capturedAt,
    capturedAtIso: new Date(capturedAt).toISOString(),
    ageMs,
    label: formatAge(ageMs),
  };
}

function formatLocalTimestamp(
  timestamp: number,
  now: number,
  options: ProviderUsageFormatOptions,
): string {
  const date = new Date(timestamp);
  const includeYear = date.getFullYear() !== new Date(now).getFullYear();
  return new Intl.DateTimeFormat(options.locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

function formatRelativeTime(deltaMs: number): string {
  const past = deltaMs < 0;
  const absoluteMs = Math.abs(deltaMs);
  const minutes = Math.floor(absoluteMs / 60_000);
  let value: string;
  if (minutes < 1) {
    value = "less than 1m";
  } else if (minutes < 60) {
    value = `${minutes}m`;
  } else if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    value = remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
  } else {
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.floor((minutes % (24 * 60)) / 60);
    value = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return past ? `${value} ago` : `in ${value}`;
}

function formatAge(ageMs: number): string {
  if (ageMs < 5_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 24 * 60 * 60_000) {
    const hours = Math.floor(ageMs / (60 * 60_000));
    const minutes = Math.floor((ageMs % (60 * 60_000)) / 60_000);
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(ageMs / (24 * 60 * 60_000));
  const hours = Math.floor((ageMs % (24 * 60 * 60_000)) / (60 * 60_000));
  return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`;
}

function legacyWindowLabel(label: string | null): string {
  if (label === "weekly") return "7d";
  if (label === "req/h") return "1h";
  return label ?? "quota";
}

function providerLabel(id: string, label: string | null): string {
  const normalized = id.trim().toLowerCase();
  if (PROVIDER_LABELS[normalized]) return PROVIDER_LABELS[normalized]!;
  const source = label ?? id;
  return source
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Unknown";
}

function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function roundPercent(percent: number): number {
  return Math.round(percent * 10) / 10;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
