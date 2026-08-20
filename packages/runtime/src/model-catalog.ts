import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ScoutModelCatalogEntry } from "@openscout/protocol";

import type { RuntimeModelCatalogInput } from "./capability-matrix.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export const RUNTIME_MODEL_CATALOG_FILE = "model-catalog.json";

export type RuntimeModelCatalogFile = {
  version?: number;
  id?: string;
  name?: string;
  models?: unknown;
  [key: string]: unknown;
};

export type LoadRuntimeModelCatalogOptions = {
  path?: string;
  capturedAt?: number;
};

export type RuntimeModelCatalogLoadResult = {
  input: RuntimeModelCatalogInput | null;
  warnings: string[];
};

export function resolveRuntimeModelCatalogPath(path?: string): string {
  return path ?? join(resolveOpenScoutSupportPaths().catalogDirectory, RUNTIME_MODEL_CATALOG_FILE);
}

export async function loadRuntimeModelCatalogInput(
  options: LoadRuntimeModelCatalogOptions = {},
): Promise<RuntimeModelCatalogLoadResult> {
  const path = resolveRuntimeModelCatalogPath(options.path);
  try {
    const raw = await readFile(path, "utf8");
    return normalizeRuntimeModelCatalogFile(JSON.parse(raw), {
      sourcePath: path,
      capturedAt: options.capturedAt,
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      return { input: null, warnings: [] };
    }
    return {
      input: null,
      warnings: [`Could not read model catalog at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function normalizeRuntimeModelCatalogFile(
  value: unknown,
  options: { sourcePath?: string; capturedAt?: number } = {},
): RuntimeModelCatalogLoadResult {
  if (!value || typeof value !== "object") {
    return {
      input: null,
      warnings: ["Model catalog must be a JSON object."],
    };
  }

  const file = value as RuntimeModelCatalogFile;
  const rawModels = Array.isArray(file.models) ? file.models : [];
  const models = rawModels
    .map(normalizeModelCatalogEntry)
    .filter((entry): entry is ScoutModelCatalogEntry => Boolean(entry));

  if (rawModels.length > 0 && models.length === 0) {
    return {
      input: null,
      warnings: ["Model catalog did not contain any usable model entries."],
    };
  }

  if (models.length === 0) {
    return { input: null, warnings: [] };
  }

  const id = typeof file.id === "string" && file.id.trim()
    ? file.id.trim()
    : "local-model-catalog";
  const name = typeof file.name === "string" && file.name.trim()
    ? file.name.trim()
    : "Local model catalog";

  return {
    input: {
      kind: "model_catalog",
      id,
      name,
      capturedAt: options.capturedAt,
      raw: {
        sourcePath: options.sourcePath,
        catalog: file,
      },
      models,
    },
    warnings: [],
  };
}

function normalizeModelCatalogEntry(value: unknown): ScoutModelCatalogEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<ScoutModelCatalogEntry>;
  const providerId = typeof candidate.providerId === "string" ? candidate.providerId.trim() : "";
  const modelId = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
  if (!providerId || !modelId) {
    return null;
  }

  return {
    ...candidate,
    providerId,
    modelId,
  };
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === "object"
    && (error as { code?: unknown }).code === "ENOENT";
}
