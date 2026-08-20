#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, "packages/protocol/src/runtime-catalog.v1.json");
const output = resolve(root, "packages/protocol/src/runtime-catalog.generated.ts");
const windowOutput = resolve(root, "packages/agent-sessions/src/runtime-model-windows.generated.ts");
const publishedOutput = resolve(root, "landing/openscout.app/public/.well-known/runtime-catalog.v1.json");
const catalog = JSON.parse(await readFile(source, "utf8"));
const { parseScoutRuntimeCatalog } = await import("../packages/protocol/src/runtime-catalog.ts");
const validated = parseScoutRuntimeCatalog(catalog);
if (!validated.ok) throw new Error(`runtime-catalog.v1.json is invalid: ${validated.errors.join("; ")}`);

await writeFile(
  output,
  `// Generated automatically from runtime-catalog.v1.json. Do not edit.\n\nexport const SCOUT_RUNTIME_CATALOG_DATA = ${JSON.stringify(catalog, null, 2)} as const;\n`,
);
// The landing site lives only in the private repo; skip its well-known
// mirror when the directory is absent.
if (existsSync(resolve(root, "landing/openscout.app/public/.well-known"))) {
  await writeFile(publishedOutput, `${JSON.stringify(catalog, null, 2)}\n`);
}

const windows = Object.fromEntries(catalog.harnesses.flatMap((harness: { models?: unknown[] }) =>
  Array.isArray(harness.models) ? harness.models.flatMap((entry: unknown) => {
    const model = entry as { id?: unknown; contextWindowTokens?: unknown };
    return typeof model.id === "string"
      && Number.isInteger(model.contextWindowTokens)
      && Number(model.contextWindowTokens) > 0
      ? [[model.id.toLowerCase().replace(/[._]/gu, "-"), Number(model.contextWindowTokens)]]
      : [];
  }) : [],
));
await writeFile(
  windowOutput,
  `// Generated automatically from the Scout runtime catalog. Do not edit.\n\nexport const RUNTIME_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = ${JSON.stringify(windows, null, 2)};\n`,
);
