import { describe, expect, test } from "bun:test";
import type { ScoutOwnedRuntimeCatalog } from "@openscout/protocol";

import type { BrokerRuntimeProfile } from "./broker-runtime-profiles.js";
import { resolveRuntimeListPreferences } from "./runtime-list-preferences.js";

function model(id: string) {
  return { id, label: id, enabled: true };
}

const CATALOG: ScoutOwnedRuntimeCatalog = {
  schemaVersion: "openscout.runtime-catalog.v1",
  revision: "test",
  harnesses: [
    {
      id: "claude",
      label: "Claude Code",
      enabled: true,
      reasoningEfforts: null,
      models: [model("opus"), model("fable-5.1")],
    },
    {
      id: "codex",
      label: "Codex",
      enabled: true,
      reasoningEfforts: null,
      models: [model("gpt-6-astra")],
    },
    {
      id: "opencode",
      label: "OpenCode",
      enabled: true,
      reasoningEfforts: null,
      models: [model("opencode-go/glm-5.2")],
    },
    {
      id: "pi",
      label: "Pi",
      enabled: false,
      reasoningEfforts: null,
      models: [model("pi-1")],
    },
  ],
};

const BROKER_PROFILES: BrokerRuntimeProfile[] = [
  {
    id: "fable",
    displayName: "Fable",
    supportsReasoningEffort: true,
    execution: { harness: "claude", model: "fable", session: "new" },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    supportsReasoningEffort: false,
    execution: { harness: "opencode", session: "new" },
  },
  {
    id: "oc",
    displayName: "OpenCode",
    supportsReasoningEffort: false,
    execution: { harness: "opencode", session: "new" },
  },
];

describe("resolveRuntimeListPreferences", () => {
  test("empty inputs resolve to empty lists", () => {
    const resolved = resolveRuntimeListPreferences({ catalog: CATALOG });
    expect(resolved).toEqual({ shortlist: [], presets: [], warnings: [] });
  });

  test("layers project over user over harness preferences", () => {
    const resolved = resolveRuntimeListPreferences({
      catalog: CATALOG,
      project: { shortlist: ["claude/fable-5.1"], presets: [] },
      user: { runtimeShortlist: ["claude/fable-5.1", "codex/gpt-6-astra"] },
      harness: {
        claude: {
          favorites: ["fable-5.1"],
          defaultModel: "opus",
          recent: [],
          profiles: [],
        },
      },
    });
    expect(resolved.shortlist).toEqual([
      { harness: "claude", model: "fable-5.1", origin: "project" },
      { harness: "codex", model: "gpt-6-astra", origin: "user" },
      { harness: "claude", model: "opus", origin: "harness-default" },
    ]);
  });

  test("keeps unknown models for project/user origins but drops harness-native aliases", () => {
    const resolved = resolveRuntimeListPreferences({
      catalog: CATALOG,
      user: { runtimeShortlist: ["claude/not-in-catalog-yet"] },
      harness: {
        claude: {
          favorites: [],
          defaultModel: "opus-alias-from-claude",
          recent: ["fable-5.1"],
          profiles: [],
        },
      },
    });
    expect(resolved.shortlist).toEqual([
      { harness: "claude", model: "not-in-catalog-yet", origin: "user" },
      { harness: "claude", model: "fable-5.1", origin: "harness-recent" },
    ]);
    expect(resolved.warnings).toEqual([]);
  });

  test("opencode qualified ids match the catalog; bare ids drop silently", () => {
    const resolved = resolveRuntimeListPreferences({
      catalog: CATALOG,
      harness: {
        opencode: {
          favorites: ["opencode-go/glm-5.2", "glm-5.2"],
          recent: [],
          profiles: [],
        },
      },
    });
    expect(resolved.shortlist).toEqual([
      { harness: "opencode", model: "opencode-go/glm-5.2", origin: "harness-favorite" },
    ]);
  });

  test("drops entries for unknown or disabled harnesses with warnings", () => {
    const resolved = resolveRuntimeListPreferences({
      catalog: CATALOG,
      user: { runtimeShortlist: ["pi/pi-1"] },
      project: { presets: [{ id: "gone", runtime: "notharness/x" }] },
    });
    expect(resolved.shortlist).toEqual([]);
    expect(resolved.presets).toEqual([]);
    expect(resolved.warnings).toHaveLength(2);
    expect(resolved.warnings[0]).toContain("pi/pi-1");
    expect(resolved.warnings[1]).toContain("gone");
  });

  test("presets layer project over user over harness profiles over broker", () => {
    const resolved = resolveRuntimeListPreferences({
      catalog: CATALOG,
      project: {
        presets: [{ id: "fusion", label: "Fusion", runtime: "claude/fable-5.1/medium" }],
      },
      user: {
        runtimePresets: [
          { id: "fusion", runtime: "codex/gpt-6-astra/low" },
          { id: "spark", runtime: "codex/gpt-6-astra/high" },
        ],
      },
      harness: {
        codex: {
          favorites: [],
          recent: [],
          profiles: [{ id: "deep", label: "deep", model: "gpt-6-astra", effort: "high" }],
        },
      },
      brokerProfiles: BROKER_PROFILES,
    });
    expect(resolved.presets).toEqual([
      { id: "fusion", label: "Fusion", harness: "claude", model: "fable-5.1", effort: "medium", origin: "project" },
      { id: "spark", label: "spark", harness: "codex", model: "gpt-6-astra", effort: "high", origin: "user" },
      { id: "deep", label: "deep", harness: "codex", model: "gpt-6-astra", effort: "high", origin: "harness-profile" },
      { id: "fable", label: "Fable", harness: "claude", model: "fable", origin: "broker-profile" },
      { id: "opencode", label: "OpenCode", harness: "opencode", origin: "broker-profile" },
    ]);
  });

  test("broker oc/opencode alias dedupes to the canonical id", () => {
    const resolved = resolveRuntimeListPreferences({
      catalog: CATALOG,
      brokerProfiles: BROKER_PROFILES,
    });
    const ids = resolved.presets.map((preset) => preset.id);
    expect(ids).toContain("opencode");
    expect(ids).not.toContain("oc");
  });

  test("harness profile with an unknown model drops silently", () => {
    const resolved = resolveRuntimeListPreferences({
      catalog: CATALOG,
      harness: {
        codex: {
          favorites: [],
          recent: [],
          profiles: [
            { id: "elsewhere", label: "elsewhere", model: "some-other-tool-model" },
            { id: "deep", label: "deep", model: "gpt-6-astra" },
          ],
        },
      },
    });
    expect(resolved.presets.map((preset) => preset.id)).toEqual(["deep"]);
    expect(resolved.warnings).toEqual([]);
  });
});
