import { describe, expect, test } from "bun:test";

import {
  MAX_RUNTIME_MODELS_PER_HARNESS,
  parseScoutRuntimeCatalog,
} from "./runtime-catalog.js";
import { SCOUT_RUNTIME_CATALOG } from "./runtime-execution.js";

describe("runtime catalog", () => {
  test("accepts the bundled catalog and exposes Astra, Fable 5, and Grok 4.6", () => {
    const parsed = parseScoutRuntimeCatalog(SCOUT_RUNTIME_CATALOG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.catalog.revision).toBe("2026-09-10.1");
    expect(parsed.catalog.harnesses.find((entry) => entry.id === "codex")?.models[0])
      .toEqual(expect.objectContaining({
        id: "gpt-6-astra",
        label: "6 Astra",
        default: true,
        contextWindowTokens: 1_050_000,
      }));
    expect(parsed.catalog.harnesses.find((entry) => entry.id === "claude")?.models)
      .toContainEqual(expect.objectContaining({ id: "claude-fable-5", label: "Fable 5" }));
    expect(parsed.catalog.harnesses.find((entry) => entry.id === "grok")?.models[0]?.id)
      .toBe("grok-4.6");
    expect(parsed.catalog.harnesses.find((entry) => entry.id === "grok")?.models[0]?.contextWindowTokens)
      .toBe(500_000);
    expect(parsed.catalog.harnesses.find((entry) => entry.id === "grok")?.listed).toBe(false);
  });

  test("offers only the Grok models the CLI actually serves, with effort on both entries", () => {
    const parsed = parseScoutRuntimeCatalog(SCOUT_RUNTIME_CATALOG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // grok-4.3 was never a real model id: `session/set_model` answers it with
    // -32602 "unknown model id", which fails the whole session start.
    for (const id of ["grok", "grok-acp"]) {
      const harness = parsed.catalog.harnesses.find((entry) => entry.id === id);
      expect(harness?.models.map((model) => model.id)).toEqual(["grok-4.6", "grok-4.5"]);
      expect(harness?.models.every((model) => model.contextWindowTokens === 500_000)).toBe(true);
      expect(harness?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
      expect(harness?.defaultReasoningEffort).toBe("high");
    }
  });

  test("rejects malformed revisions without partially accepting them", () => {
    const parsed = parseScoutRuntimeCatalog({
      schemaVersion: "openscout.runtime-catalog.v1",
      revision: "bad",
      harnesses: [{
        id: "grok",
        label: "Grok",
        enabled: true,
        default: true,
        reasoningEfforts: ["warp"],
        models: [],
      }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("unknown effort warp");
  });

  test("rejects an unbounded model list", () => {
    const parsed = parseScoutRuntimeCatalog({
      schemaVersion: "openscout.runtime-catalog.v1",
      revision: "2026-08-12.2",
      harnesses: [{
        id: "grok",
        label: "Grok",
        enabled: true,
        default: true,
        reasoningEfforts: ["medium"],
        models: Array.from({ length: MAX_RUNTIME_MODELS_PER_HARNESS + 1 }, (_, index) => ({
          id: `grok-test-${index}`,
          label: `Grok Test ${index}`,
          enabled: true,
        })),
      }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("model limit");
  });

  test("rejects non-boolean picker visibility", () => {
    const parsed = parseScoutRuntimeCatalog({
      ...SCOUT_RUNTIME_CATALOG,
      revision: "2026-08-18.2",
      harnesses: SCOUT_RUNTIME_CATALOG.harnesses.map((entry) => entry.id === "grok"
        ? { ...entry, listed: "no" }
        : entry),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("listed must be boolean");
  });
});
