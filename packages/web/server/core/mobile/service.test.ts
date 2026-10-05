import { expect, test } from "bun:test";
import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";

import { getScoutMobileRuntimeCapabilities } from "./service.ts";

test("mobile capabilities use the bundled published catalog while offline", async () => {
  const catalog = await getScoutMobileRuntimeCapabilities(undefined, async () => null);
  expect(catalog.schemaVersion).toBe("openscout.runtime-capabilities.v1");
  expect(catalog.catalogVersion).toBe("openscout.runtime-catalog.v1");
  expect(catalog.defaults).toEqual({
    harness: "claude",
    model: "claude-opus-5-5",
    reasoningEffort: "medium",
  });
  expect(catalog.harnesses.map((harness) => harness.id)).toContain("codex");
  expect(catalog.harnesses.map((harness) => harness.id)).not.toContain("grok");
  expect(catalog.harnesses.find((harness) => harness.id === "grok-acp")?.label).toBe("Grok");
  expect(catalog.models.some((model) => (
    model.id === "gpt-5.6-sol" && model.harnesses.includes("codex")
  ))).toBe(true);
  expect(catalog.defaultsByHarness.codex?.model).toBe("gpt-6-astra");
  expect(catalog.efforts.find((effort) => effort.id === "ultra")).toBeDefined();
});

test("mobile runtime capabilities adopt scoutd's live catalog", async () => {
  const liveCatalog = {
    ...SCOUT_RUNTIME_CATALOG,
    revision: "2026-08-12.2",
    harnesses: SCOUT_RUNTIME_CATALOG.harnesses.map((harness) => harness.id === "grok"
      ? {
          ...harness,
          models: [{
            id: "grok-mobile-live",
            label: "Grok Mobile Live",
            enabled: true,
            default: true,
          }, ...harness.models.map((model) => ({ ...model, default: false }))],
        }
      : harness),
  };
  const catalog = await getScoutMobileRuntimeCapabilities(undefined, async () => ({
    catalog: liveCatalog,
    warnings: [],
  }));
  expect(catalog.catalogRevision).toBe("2026-08-12.2");
  expect(catalog.models.some((model) => model.id === "grok-mobile-live")).toBe(true);
});

test("mobile project scope does not require local model discovery", async () => {
  const catalog = await getScoutMobileRuntimeCapabilities("/Users/tester/dev/project", async () => ({
    catalog: SCOUT_RUNTIME_CATALOG, warnings: [], source: "persisted", checkedAt: 123,
  }));
  expect(catalog.projectRoot).toBe("/Users/tester/dev/project");
  expect(catalog.source).toBe("persisted");
  expect(catalog.checkedAt).toBe(123);
  expect(catalog.models.some((model) => model.harnesses.includes("codex"))).toBe(true);
});
