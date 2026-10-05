import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkCatalogOutputs,
  renderCatalogOutputs,
  renderLandingMirror,
  RUNTIME_CATALOG_SOURCE,
  RUNTIME_CATALOG_TS_OUTPUT,
  verifyPublishedRuntimeCatalog,
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

  test("publication verification requires the exact reviewed data, independently of package versions", async () => {
    const source = await Bun.file(join(repoRoot, RUNTIME_CATALOG_SOURCE)).json();
    expect(await verifyPublishedRuntimeCatalog(repoRoot, async () => new Response(renderLandingMirror(source)))).toBe(source.revision);
    const altered = structuredClone(source);
    altered.harnesses[0].models[0].enabled = false;
    delete altered.harnesses[0].models[0].default;
    await expect(verifyPublishedRuntimeCatalog(repoRoot, async () => new Response(renderLandingMirror(altered)))).rejects.toThrow("does not match");
  });

  test("publication verification rejects extra fields and byte drift that client parsing would normalize", async () => {
    const source = await Bun.file(join(repoRoot, RUNTIME_CATALOG_SOURCE)).json();
    await expect(verifyPublishedRuntimeCatalog(repoRoot, async () => new Response(renderLandingMirror({ ...source, unexpected: true })))).rejects.toThrow("does not match");
    await expect(verifyPublishedRuntimeCatalog(repoRoot, async () => Response.json(source))).rejects.toThrow("does not match");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(renderLandingMirror(source))]);
    await expect(verifyPublishedRuntimeCatalog(repoRoot, async () => new Response(withBom))).rejects.toThrow("does not match");
  });

  test("an unavailable or malformed public catalog cannot pass publication verification", async () => {
    await expect(verifyPublishedRuntimeCatalog(repoRoot, async () => new Response("missing", { status: 404 }))).rejects.toThrow("HTTP 404");
    await expect(verifyPublishedRuntimeCatalog(repoRoot, async () => Response.json({ revision: "2026-10-05.1" }))).rejects.toThrow("invalid");
  });
});
