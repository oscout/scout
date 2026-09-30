import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkCatalogOutputs,
  renderCatalogOutputs,
  RUNTIME_CATALOG_SOURCE,
  RUNTIME_CATALOG_TS_OUTPUT,
} from "../../../scripts/generate-runtime-catalog.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

async function stageOutputs(root: string): Promise<void> {
  await mkdir(dirname(join(root, RUNTIME_CATALOG_SOURCE)), { recursive: true });
  await writeFile(
    join(root, RUNTIME_CATALOG_SOURCE),
    await Bun.file(join(repoRoot, RUNTIME_CATALOG_SOURCE)).text(),
  );
  for (const output of await renderCatalogOutputs(root)) {
    await mkdir(dirname(join(root, output.path)), { recursive: true });
    await writeFile(join(root, output.path), output.content);
  }
}

describe("runtime catalog generation", () => {
  test("render is deterministic", async () => {
    const first = await renderCatalogOutputs(repoRoot);
    const second = await renderCatalogOutputs(repoRoot);
    expect(second.map((output) => output.path)).toEqual(first.map((output) => output.path));
    expect(second.map((output) => output.content)).toEqual(first.map((output) => output.content));
  });

  test("check reports NO MATCH when a generated file drifts", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "runtime-catalog-check-"));
    await stageOutputs(tmp);
    const clean = await checkCatalogOutputs(tmp);
    expect(clean.every((result) => result.match)).toBe(true);

    await writeFile(join(tmp, RUNTIME_CATALOG_TS_OUTPUT), "// tampered\n");
    const drifted = await checkCatalogOutputs(tmp);
    const tampered = drifted.find((result) => result.path === RUNTIME_CATALOG_TS_OUTPUT);
    expect(tampered?.match).toBe(false);
    expect(tampered?.detail).toContain("first difference");
    expect(drifted.filter((result) => !result.match)).toHaveLength(1);
  });
});
