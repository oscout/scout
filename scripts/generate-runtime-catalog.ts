#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseScoutRuntimeCatalog } from "../packages/protocol/src/runtime-catalog.ts";

export const RUNTIME_CATALOG_SOURCE = "packages/protocol/src/runtime-catalog.v1.json";
export const RUNTIME_CATALOG_TS_OUTPUT = "packages/protocol/src/runtime-catalog.generated.ts";
export const RUNTIME_MODEL_WINDOWS_OUTPUT =
  "packages/agent-sessions/src/runtime-model-windows.generated.ts";
const LANDING_MIRROR_DIR = "landing/openscout.app/public/.well-known";
export const RUNTIME_CATALOG_LANDING_OUTPUT = `${LANDING_MIRROR_DIR}/runtime-catalog.v1.json`;

export type CatalogOutput = {
  /** Repo-relative output path. */
  path: string;
  /** The exact bytes the file must contain. */
  content: string;
};

export function renderRuntimeCatalogTs(catalog: unknown): string {
  return `// Generated automatically from runtime-catalog.v1.json. Do not edit.\n\nexport const SCOUT_RUNTIME_CATALOG_DATA = ${JSON.stringify(catalog, null, 2)} as const;\n`;
}

export function renderModelContextWindows(catalog: { harnesses?: unknown[] }): string {
  const windows = Object.fromEntries((catalog.harnesses ?? []).flatMap((harness: { models?: unknown[] }) =>
    Array.isArray(harness.models) ? harness.models.flatMap((entry: unknown) => {
      const model = entry as { id?: unknown; contextWindowTokens?: unknown };
      return typeof model.id === "string"
        && Number.isInteger(model.contextWindowTokens)
        && Number(model.contextWindowTokens) > 0
        ? [[model.id.toLowerCase().replace(/[._]/gu, "-"), Number(model.contextWindowTokens)]]
        : [];
    }) : [],
  ));
  return `// Generated automatically from the Scout runtime catalog. Do not edit.\n\nexport const RUNTIME_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = ${JSON.stringify(windows, null, 2)};\n`;
}

export function renderLandingMirror(catalog: unknown): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/// Parse the source JSON and render every generated output in memory. The
/// landing mirror is only emitted when its directory exists — the site lives
/// in the private repo, so public checkouts skip it.
export async function renderCatalogOutputs(root: string): Promise<CatalogOutput[]> {
  const raw = await readFile(resolve(root, RUNTIME_CATALOG_SOURCE), "utf8");
  const catalog = JSON.parse(raw);
  const validated = parseScoutRuntimeCatalog(catalog);
  if (!validated.ok) {
    throw new Error(`runtime-catalog.v1.json is invalid: ${validated.errors.join("; ")}`);
  }
  const outputs: CatalogOutput[] = [
    { path: RUNTIME_CATALOG_TS_OUTPUT, content: renderRuntimeCatalogTs(catalog) },
    { path: RUNTIME_MODEL_WINDOWS_OUTPUT, content: renderModelContextWindows(catalog) },
  ];
  if (existsSync(resolve(root, LANDING_MIRROR_DIR))) {
    outputs.push({ path: RUNTIME_CATALOG_LANDING_OUTPUT, content: renderLandingMirror(catalog) });
  }
  return outputs;
}

export type CatalogCheckResult = {
  path: string;
  match: boolean;
  /** First-difference hint when the bytes on disk drifted. */
  detail?: string;
};

function firstDifference(existing: string | null, rendered: string): string {
  if (existing === null) return "file is missing";
  const left = existing.split("\n");
  const right = rendered.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return `first difference at line ${index + 1}:\n        - ${left[index] ?? "<eof>"}\n        + ${right[index] ?? "<eof>"}`;
    }
  }
  return "contents differ";
}

/// Render every output and compare byte-for-byte with disk. Never writes.
export async function checkCatalogOutputs(root: string): Promise<CatalogCheckResult[]> {
  const outputs = await renderCatalogOutputs(root);
  const results: CatalogCheckResult[] = [];
  for (const output of outputs) {
    const existing = await readFile(resolve(root, output.path), "utf8").catch(() => null);
    const match = existing === output.content;
    results.push({
      path: output.path,
      match,
      ...(match ? {} : { detail: firstDifference(existing, output.content) }),
    });
  }
  return results;
}

async function main() {
  const root = resolve(import.meta.dir, "..");
  if (process.argv.slice(2).includes("--check")) {
    const results = await checkCatalogOutputs(root);
    let failed = false;
    for (const result of results) {
      if (result.match) {
        console.log(`match  ${result.path}`);
      } else {
        failed = true;
        console.log(`NO MATCH  ${result.path}`);
        if (result.detail) console.log(`        ${result.detail}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }
  for (const output of await renderCatalogOutputs(root)) {
    await writeFile(resolve(root, output.path), output.content);
    console.log(`wrote  ${relative(root, resolve(root, output.path))}`);
  }
}

if (import.meta.main) await main();
