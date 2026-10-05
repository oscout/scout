#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseScoutRuntimeCatalog } from "../packages/protocol/src/runtime-catalog.ts";
import type { ScoutOwnedRuntimeCatalog } from "../packages/protocol/src/runtime-catalog-contract.ts";

export const MODEL_METADATA_URL = "https://models.dev/models.json";
const MAX_METADATA_BYTES = 8_388_608;

// These mappings select a review source, never a launch identifier or an
// enabled model. Multi-provider harnesses need an explicit serving mapping.
const SOURCE_LABS: Readonly<Record<string, string>> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  grok: "xai",
  kimi: "moonshotai",
};

type ModelFacts = {
  id: string;
  name: string;
  contextWindowTokens?: number;
  releaseDate?: string;
};

function modelFacts(key: string, value: unknown): ModelFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry.id !== key || typeof entry.name !== "string" || !entry.name.trim()) return null;
  const modalities = entry.modalities as { output?: unknown } | undefined;
  if (entry.tool_call !== true || !Array.isArray(modalities?.output) || !modalities.output.includes("text")) return null;
  const limit = entry.limit as { context?: unknown } | undefined;
  const context = limit?.context;
  return {
    id: key,
    name: entry.name.trim(),
    ...(Number.isSafeInteger(context) && Number(context) > 0 ? { contextWindowTokens: Number(context) } : {}),
    ...(typeof entry.release_date === "string" ? { releaseDate: entry.release_date } : {}),
  };
}

/** Report candidate facts without changing Scout's enablement, IDs or defaults. */
export function runtimeModelUpdateReport(catalog: ScoutOwnedRuntimeCatalog, metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Model metadata must be an object keyed by canonical lab/model ID.");
  }
  const facts = Object.entries(metadata).map(([key, value]) => modelFacts(key, value)).filter((entry): entry is ModelFacts => entry !== null);
  if (!facts.length) throw new Error("Model metadata contains no valid text models with tool support.");
  const updates: Array<Record<string, unknown>> = [];
  const missing: Array<{ harness: string; model: string; sourceId: string }> = [];
  for (const harness of catalog.harnesses) {
    const lab = SOURCE_LABS[harness.id];
    if (!lab) continue;
    const upstream = facts.filter((entry) => entry.id.startsWith(`${lab}/`));
    for (const model of harness.models) {
      const sourceId = `${lab}/${model.id}`;
      const observed = upstream.find((entry) => entry.id === sourceId);
      if (!observed) {
        missing.push({ harness: harness.id, model: model.id, sourceId });
      } else if (observed.contextWindowTokens !== undefined && observed.contextWindowTokens !== model.contextWindowTokens) {
        updates.push({
          kind: "context-window", harness: harness.id, model: model.id, sourceId,
          current: model.contextWindowTokens ?? null, proposed: observed.contextWindowTokens,
        });
      }
    }
    for (const model of upstream) {
      const id = model.id.slice(lab.length + 1);
      if (harness.models.some((entry) => entry.id === id)) continue;
      updates.push({ kind: "new-model", harness: harness.id, sourceId: model.id,
        proposedId: id, name: model.name, contextWindowTokens: model.contextWindowTokens ?? null,
        releaseDate: model.releaseDate ?? null });
    }
  }
  updates.sort((a, b) => JSON.stringify([a.harness, a.sourceId]).localeCompare(JSON.stringify([b.harness, b.sourceId])));
  missing.sort((a, b) => `${a.harness}/${a.model}`.localeCompare(`${b.harness}/${b.model}`));
  return {
    schemaVersion: "openscout.runtime-model-update-report.v1",
    catalogRevision: catalog.revision,
    source: MODEL_METADATA_URL,
    updates,
    missing,
    note: "Review candidates against the harness and provider documentation. Context values are provider/API metadata, not verified harness budgets. This report does not enable models, alter defaults, infer aliases, or prove account access.",
  };
}

export async function readModelMetadata(fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(MODEL_METADATA_URL, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Model metadata request failed: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_METADATA_BYTES) throw new Error("Model metadata exceeds the review size limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model metadata response has no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_METADATA_BYTES) {
      await reader.cancel();
      throw new Error("Model metadata exceeds the review size limit.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      console.log("Usage: bun scripts/check-runtime-model-updates.ts\n\nPrint a read-only Models.dev comparison. Review the report, then edit Scout's catalog JSON and publish the site independently of app/package releases.");
      return;
    }
    throw new Error("Unknown argument. Use --help for usage.");
  }
  const raw = JSON.parse(await readFile(resolve(import.meta.dir, "../packages/protocol/src/runtime-catalog.v1.json"), "utf8"));
  const parsed = parseScoutRuntimeCatalog(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  console.log(JSON.stringify(runtimeModelUpdateReport(parsed.catalog, await readModelMetadata()), null, 2));
}

if (import.meta.main) await main();
