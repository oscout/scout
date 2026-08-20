import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadRuntimeModelCatalogInput,
  normalizeRuntimeModelCatalogFile,
  resolveRuntimeModelCatalogPath,
} from "./model-catalog.js";

describe("runtime model catalog", () => {
  test("resolves the default catalog path under the support catalog directory", () => {
    expect(resolveRuntimeModelCatalogPath().endsWith("catalog/model-catalog.json")).toBe(true);
  });

  test("normalizes usable model entries into a runtime input", () => {
    const result = normalizeRuntimeModelCatalogFile({
      id: "local-models",
      name: "Local Models",
      models: [
        {
          providerId: " local ",
          modelId: " scout-small ",
          displayName: "Scout Small",
          inputModalities: ["text"],
          outputModalities: ["text"],
          features: { streaming: true, toolCalling: true },
          contextWindowTokens: 128_000,
        },
        { providerId: "", modelId: "ignored" },
      ],
    }, { sourcePath: "/tmp/model-catalog.json", capturedAt: 123 });

    expect(result.warnings).toEqual([]);
    expect(result.input).toMatchObject({
      kind: "model_catalog",
      id: "local-models",
      name: "Local Models",
      capturedAt: 123,
      models: [{
        providerId: "local",
        modelId: "scout-small",
        displayName: "Scout Small",
      }],
    });
    expect(result.input?.raw).toMatchObject({
      sourcePath: "/tmp/model-catalog.json",
    });
  });

  test("treats absent catalogs as optional", async () => {
    const result = await loadRuntimeModelCatalogInput({
      path: join(tmpdir(), `missing-model-catalog-${Date.now()}.json`),
    });

    expect(result).toEqual({ input: null, warnings: [] });
  });

  test("returns warnings for malformed catalog files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-model-catalog-"));
    const path = join(directory, "model-catalog.json");
    try {
      writeFileSync(path, "{ not json", "utf8");

      const result = await loadRuntimeModelCatalogInput({ path });

      expect(result.input).toBeNull();
      expect(result.warnings[0]).toContain("Could not read model catalog");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
