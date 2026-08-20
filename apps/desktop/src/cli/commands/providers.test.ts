import { describe, expect, test } from "bun:test";

import { createScoutCommandContext, type ScoutCommandContext } from "../context.ts";
import {
  buildProviderUsageReport,
  parseProvidersCommandOptions,
  renderProviderUsageReport,
  renderProvidersCommandHelp,
  runProvidersCommand,
  type ServiceBudgetsPayload,
} from "./providers.ts";

const NOW = Date.UTC(2026, 7, 11, 18, 0, 0);
const GENERATED_AT = NOW - 2_000;

const serviceBudgetsPayload: ServiceBudgetsPayload = {
  generatedAt: GENERATED_AT,
  gauges: [
    {
      id: "claude",
      label: "claude",
      kind: "quota",
      fill: 0.4,
      plan: "Max",
      capturedAt: NOW - 60_000,
      source: "provider report",
      windows: [
        {
          label: "5h",
          fill: 0.125,
          resetAt: NOW + 2 * 60 * 60_000,
          capturedAt: NOW - 60_000,
          source: "Claude local status",
        },
        {
          label: "7d",
          fill: 0.4,
          resetAt: NOW + 6 * 24 * 60 * 60_000,
          capturedAt: NOW - 90_000,
          source: "Claude local status",
        },
      ],
    },
    {
      id: "codex",
      label: "codex",
      kind: "quota",
      fill: 0.61,
      windows: [
        {
          label: "7d",
          fill: 0.61,
          resetAt: NOW + 5 * 24 * 60 * 60_000,
          capturedAt: NOW - 4_000,
          source: "Codex local session",
        },
      ],
    },
    {
      id: "nova-ai",
      label: "nova ai",
      kind: "quota",
      fill: 0.2,
      unitLabel: "weekly",
      resetAt: NOW + 7 * 24 * 60 * 60_000,
      capturedAt: NOW - 30_000,
      source: "provider report",
    },
    {
      id: "minimax",
      label: "minimax",
      kind: "quota",
      fill: 0.7,
      windows: [
        {
          label: "5h",
          fill: 0.2,
          resetAt: NOW + 3 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
        {
          label: "7d",
          fill: 0.4,
          resetAt: NOW + 4 * 24 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
        {
          label: "video 1d",
          fill: 0.6,
          resetAt: NOW + 20 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
        {
          label: "video 7d",
          fill: 0.7,
          resetAt: NOW + 5 * 24 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
      ],
    },
    {
      id: "cursor",
      label: "cursor",
      kind: "status",
      statusLabel: "Pro",
    },
  ],
};

const formatOptions = {
  now: NOW,
  locale: "en-US",
  timeZone: "UTC",
} as const;

describe("providers command", () => {
  test("documents the live usage view and structured output", () => {
    const help = renderProvidersCommandHelp();

    expect(help).toContain("scout providers usage");
    expect(help).toContain("every provider quota window");
    expect(help).toContain("--cached");
    expect(help).toContain("--json");
  });

  test("defaults to a forced refresh and accepts an explicit cached read", () => {
    expect(parseProvidersCommandOptions(["usage"])).toEqual({
      command: "usage",
      forceRefresh: true,
    });
    expect(parseProvidersCommandOptions(["usage", "--cached"])).toEqual({
      command: "usage",
      forceRefresh: false,
    });
    expect(() => parseProvidersCommandOptions(["usage", "--refresh", "--cached"]))
      .toThrow("only one of --refresh or --cached");
  });

  test("preserves every quota window and future providers", () => {
    const report = buildProviderUsageReport(serviceBudgetsPayload, formatOptions);

    expect(report.providers.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "nova-ai",
      "minimax",
    ]);
    expect(report.providers[0]?.windows.map((window) => window.label)).toEqual(["5h", "7d"]);
    expect(report.providers[1]?.windows.map((window) => window.label)).toEqual(["7d"]);
    expect(report.providers[2]).toMatchObject({
      label: "Nova Ai",
      windows: [{ label: "7d", usedPercent: 20, percentRemaining: 80 }],
    });
    expect(report.providers[3]?.windows.map((window) => window.label)).toEqual([
      "5h",
      "7d",
      "video 1d",
      "video 7d",
    ]);
    expect(report.providers[0]?.windows[0]).toMatchObject({
      usedPercent: 12.5,
      percentRemaining: 87.5,
      resetAtIso: "2026-08-11T20:00:00.000Z",
      resetIn: "in 2h",
      source: "Claude local status",
      freshness: {
        capturedAt: NOW - 60_000,
        ageMs: 60_000,
        label: "1m ago",
      },
    });
    expect(report.providers[0]?.windows[0]?.resetAtLocal)
      .toMatch(/^Tue, Aug 11(?: at|,) 8:00 PM UTC$/u);
  });

  test("renders a compact local-time view with source and freshness", () => {
    const rendered = renderProviderUsageReport(
      buildProviderUsageReport(serviceBudgetsPayload, formatOptions),
    );

    expect(rendered).toContain("Provider usage · 8 windows");
    expect(rendered).toContain("Claude · Max");
    expect(rendered).toContain("5h  12.5% used · 87.5% remaining");
    expect(rendered).toMatch(/Tue, Aug 11(?: at|,) 8:00 PM UTC \(in 2h\)/u);
    expect(rendered).toContain("Claude local status · updated 1m ago");
    expect(rendered).toContain("Codex local session · updated just now");
    expect(rendered).toContain("video 7d  70% used · 30% remaining");
    expect(rendered).not.toContain("Cursor");
  });

  test("requests a forced pipeline refresh and emits structured JSON", async () => {
    const stdout: string[] = [];
    const paths: string[] = [];
    const context = createScoutCommandContext({
      cwd: "/tmp/openscout-test",
      env: {},
      outputMode: "json",
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      isTty: false,
    });

    await runProvidersCommand(context, ["usage"], {
      ...formatOptions,
      readJson: async <T>(_context: ScoutCommandContext, path: string): Promise<T> => {
        paths.push(path);
        return serviceBudgetsPayload as T;
      },
    });

    expect(paths).toEqual(["/api/service-budgets?refresh=1"]);
    const report = JSON.parse(stdout.join("\n"));
    expect(report).toMatchObject({
      generatedAt: GENERATED_AT,
      generatedAtIso: "2026-08-11T17:59:58.000Z",
    });
    expect(report.providers[0]).toMatchObject({
      id: "claude",
      plan: "Max",
    });
    expect(report.providers[0].windows[0]).toMatchObject({
      label: "5h",
      usedPercent: 12.5,
      percentRemaining: 87.5,
      resetAt: NOW + 2 * 60 * 60_000,
      source: "Claude local status",
      freshness: { ageMs: 60_000, label: "1m ago" },
    });
  });

  test("renders an actionable empty state", () => {
    const rendered = renderProviderUsageReport(buildProviderUsageReport({
      generatedAt: NOW,
      gauges: [],
    }, formatOptions));

    expect(rendered).toContain("No provider quota windows");
    expect(rendered).toContain("scout providers usage --refresh");
  });
});
