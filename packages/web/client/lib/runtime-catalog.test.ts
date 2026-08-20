import { describe, expect, test } from "bun:test";
import {
  RUNTIME_EFFORTS,
  describeRuntime,
  effortsFor,
  reconcileRuntime,
  resolveModel,
  runtimeCatalogFromRunnerOptions,
  searchRuntimeOptions,
  type RuntimeCatalog,
  type RuntimeValue,
} from "./runtime-catalog.ts";
import {
  RUNTIME_CAPABILITY_SEED,
  runtimeCatalogFromCapabilities,
} from "./runtime-capabilities.ts";

const CATALOG: RuntimeCatalog = {
  efforts: [
    { value: "low", label: "Low", note: "triage" },
    { value: "medium", label: "Medium", note: "default" },
    { value: "high", label: "High", note: "deep" },
    { value: "xhigh", label: "XHigh", note: "exhaustive" },
  ],
  harnesses: [
    {
      value: "claude",
      label: "Claude",
      models: [
        { value: "", label: "Default", note: "harness picks" },
        { value: "claude-opus-5", label: "Opus 5", note: "deepest" },
        { value: "claude-haiku-4-5", label: "Haiku 4.5", note: "fastest" },
      ],
    },
    {
      value: "codex",
      label: "Codex",
      efforts: [
        { value: "low", label: "Low", note: "triage" },
        { value: "medium", label: "Medium", note: "default" },
        { value: "high", label: "High", note: "deep" },
      ],
      models: [
        { value: "", label: "Default", note: "harness picks" },
        { value: "gpt-5.5", label: "GPT-5.5" },
      ],
    },
    {
      value: "grok",
      label: "Grok",
      efforts: null,
      models: [
        { value: "", label: "Default", note: "harness picks" },
        { value: "grok-4.5", label: "Grok 4.5" },
      ],
    },
  ],
};

const VALUE: RuntimeValue = { harness: "claude", model: "claude-opus-5", effort: "high" };

describe("reconcileRuntime", () => {
  test("leaves non-harness patches alone", () => {
    expect(reconcileRuntime(CATALOG, VALUE, { model: "claude-haiku-4-5" })).toEqual({
      ...VALUE,
      model: "claude-haiku-4-5",
    });
  });

  test("resets the model to Default on harness change", () => {
    const next = reconcileRuntime(CATALOG, VALUE, { harness: "codex" });
    expect(next.model).toBe("");
  });

  test("keeps the effort when the new harness has the same rung", () => {
    const next = reconcileRuntime(CATALOG, VALUE, { harness: "codex" });
    expect(next.effort).toBe("high");
  });

  test("clamps effort by ladder position on a shorter ladder", () => {
    const next = reconcileRuntime(CATALOG, { ...VALUE, effort: "xhigh" }, { harness: "codex" });
    // xhigh is rung 4 of 4; codex's 3-rung ladder clamps to its top rung.
    expect(next.effort).toBe("high");
  });

  test("empties effort when the new harness has no effort control", () => {
    const next = reconcileRuntime(CATALOG, VALUE, { harness: "grok" });
    expect(next.effort).toBe("");
  });
});

describe("resolveModel", () => {
  test("returns the catalog entry for a known model", () => {
    expect(resolveModel(CATALOG, VALUE).label).toBe("Opus 5");
  });

  test("marks an unknown model as custom rather than lying about Default", () => {
    const resolved = resolveModel(CATALOG, { ...VALUE, model: "claude-opus-9" });
    expect(resolved).toEqual({ value: "claude-opus-9", label: "claude-opus-9", note: "custom" });
  });

  test("reads an empty model as the harness default", () => {
    expect(resolveModel(CATALOG, { ...VALUE, model: "" }).label).toBe("Default");
  });
});

describe("searchRuntimeOptions", () => {
  const options = CATALOG.harnesses[0]!.models;

  test("matches across label, value and note", () => {
    expect(searchRuntimeOptions(options, "opus").map((o) => o.value)).toEqual(["claude-opus-5"]);
    expect(searchRuntimeOptions(options, "fastest").map((o) => o.value)).toEqual(["claude-haiku-4-5"]);
  });

  test("returns the list untouched for a blank query", () => {
    expect(searchRuntimeOptions(options, "  ")).toBe(options);
  });
});

describe("describeRuntime", () => {
  test("drops effort from the summary when the harness has none", () => {
    const description = describeRuntime(CATALOG, { harness: "grok", model: "", effort: "" });
    expect(description.supportsEffort).toBe(false);
    expect(description.summary).toBe("Runtime: Grok, model Default");
  });
});

describe("runtimeCatalogFromRunnerOptions", () => {
  const built = runtimeCatalogFromRunnerOptions({
    harnesses: [
      { id: "claude", label: "Claude Code", description: null, state: null, ready: true, detail: null },
      { id: "codex", label: "Codex", description: null, state: "missing", ready: false, detail: "not installed" },
      { id: "kimi", label: "Kimi Code", description: null, state: null, ready: true, detail: null },
    ],
    models: [
      { id: "claude-opus-5", label: "Opus 5", description: "deepest", harnesses: ["claude"] },
      { id: "gpt-5.5", label: "GPT-5.5", harnesses: ["codex"] },
    ],
    efforts: [
      { id: "low", label: "Low", description: "Quick pass", harnesses: ["claude", "codex"] },
      { id: "medium", label: "Medium", description: "Balanced default", harnesses: ["claude"] },
    ],
  });

  test("nests models under the harnesses that list them, after a Default row", () => {
    const claude = built.harnesses.find((entry) => entry.value === "claude")!;
    expect(claude.models.map((model) => model.value)).toEqual(["", "claude-opus-5"]);
    expect(claude.models[1]!.note).toBe("deepest");
  });

  test("keeps unready harnesses listed but disabled, with the reason as note", () => {
    const codex = built.harnesses.find((entry) => entry.value === "codex")!;
    expect(codex.disabled).toBe(true);
    expect(codex.note).toBe("not installed");
  });

  test("gives a harness with no effort candidates efforts: null", () => {
    const kimi = built.harnesses.find((entry) => entry.value === "kimi")!;
    expect(kimi.efforts).toBeNull();
    expect(effortsFor(built, "kimi")).toBeNull();
  });

  test("uses the live ladder as the catalog fallback", () => {
    expect(built.efforts.map((step) => step.value)).toEqual(["low", "medium"]);
  });

  test("falls back to RUNTIME_EFFORTS when no efforts are listed at all", () => {
    const empty = runtimeCatalogFromRunnerOptions({ harnesses: [], models: [], efforts: [] });
    expect(empty.efforts).toBe(RUNTIME_EFFORTS);
  });

  test("carries model restrictions onto the rungs", () => {
    const scoped = runtimeCatalogFromRunnerOptions({
      harnesses: [{ id: "codex", label: "Codex" }],
      models: [
        { id: "gpt-5.6-sol", label: "Sol", harnesses: ["codex"] },
        { id: "gpt-5.5", label: "GPT-5.5", harnesses: ["codex"] },
      ],
      efforts: [
        { id: "xhigh", label: "XHigh", harnesses: ["codex"] },
        { id: "ultra", label: "Ultra", harnesses: ["codex"], models: ["gpt-5.6-sol"] },
      ],
    });
    const codex = scoped.harnesses[0]!;
    expect(codex.efforts?.[1]?.models).toEqual(["gpt-5.6-sol"]);
    expect(effortsFor(scoped, "codex", "gpt-5.6-sol")?.map((s) => s.value)).toEqual(["xhigh", "ultra"]);
    expect(effortsFor(scoped, "codex", "gpt-5.5")?.map((s) => s.value)).toEqual(["xhigh"]);
  });
});

describe("Scout-owned runtime seed", () => {
  const catalog = runtimeCatalogFromCapabilities(RUNTIME_CAPABILITY_SEED);
  const codex = catalog.harnesses.find((entry) => entry.value === "codex")!;

  test("keeps display names and effort labels aligned with the shared catalog", () => {
    expect(codex.models.map((model) => model.label)).toEqual([
      "Default",
      "5.6 Sol",
      "5.6 Terra",
      "5.6 Luna",
      "5.5",
      "5.5 mini",
    ]);
    expect(effortsFor(catalog, "codex", "gpt-5.6-sol")?.map((effort) => effort.label)).toEqual([
      "Light",
      "Medium",
      "High",
      "Extra High",
      "Ultra",
    ]);
  });

  test("uses the model-specific Scout ladder rather than vendor discovery", () => {
    expect(effortsFor(catalog, "codex", "gpt-5.6-luna")?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("applies Scout's per-harness defaults when the harness changes", () => {
    expect(reconcileRuntime(
      catalog,
      { harness: "claude", model: "claude-opus-5", effort: "high" },
      { harness: "codex" },
    )).toEqual({
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
    });
  });
});

describe("effortsFor with a selected model", () => {
  // Mirrors the live codex ladder: max stops at Luna, ultra is Sol/Terra only.
  const SCOPED: RuntimeCatalog = {
    efforts: [],
    harnesses: [
      {
        value: "claude",
        label: "Claude",
        efforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
          { value: "max", label: "Max", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] },
        ],
        models: [
          { value: "", label: "Default" },
          { value: "claude-opus-5", label: "Opus 5" },
        ],
      },
      {
        value: "codex",
        label: "Codex",
        efforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "XHigh" },
          { value: "max", label: "Max", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] },
          { value: "ultra", label: "Ultra", models: ["gpt-5.6-sol", "gpt-5.6-terra"] },
        ],
        models: [
          { value: "", label: "Default" },
          { value: "gpt-5.6-sol", label: "Sol" },
          { value: "gpt-5.6-terra", label: "Terra" },
          { value: "gpt-5.6-luna", label: "Luna" },
          { value: "gpt-5.5", label: "GPT-5.5" },
        ],
      },
    ],
  };

  const rungs = (harness: string, model?: string) =>
    effortsFor(SCOPED, harness, model)?.map((step) => step.value);

  test("no model means the harness union", () => {
    expect(rungs("codex")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(rungs("codex", "")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("narrows to the selected model's real ladder", () => {
    expect(rungs("codex", "gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(rungs("codex", "gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(rungs("codex", "gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("a restriction naming no model of this harness does not apply", () => {
    // max is restricted to gpt-* ids; Claude's own ladder keeps it.
    expect(rungs("claude", "claude-opus-5")).toEqual(["low", "high", "max"]);
  });

  test("a custom model gets the full harness ladder", () => {
    expect(rungs("codex", "gpt-9-draft")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("reconcile clamps an out-of-range rung on a model-only change", () => {
    const value: RuntimeValue = { harness: "codex", model: "gpt-5.6-sol", effort: "ultra" };
    expect(reconcileRuntime(SCOPED, value, { model: "gpt-5.6-luna" }).effort).toBe("max");
    expect(reconcileRuntime(SCOPED, value, { model: "gpt-5.5" }).effort).toBe("xhigh");
  });

  test("reconcile keeps a rung the new model still offers", () => {
    const value: RuntimeValue = { harness: "codex", model: "gpt-5.6-sol", effort: "high" };
    expect(reconcileRuntime(SCOPED, value, { model: "gpt-5.5" })).toEqual({
      ...value,
      model: "gpt-5.5",
    });
  });

  test("reconcile keeps the harness-decides empty effort", () => {
    const value: RuntimeValue = { harness: "codex", model: "gpt-5.6-sol", effort: "" };
    expect(reconcileRuntime(SCOPED, value, { model: "gpt-5.5" }).effort).toBe("");
  });
});
