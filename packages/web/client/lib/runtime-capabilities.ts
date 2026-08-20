import {
  SCOUT_RUNTIME_CATALOG,
  SCOUT_RUNTIME_DEFAULTS_BY_HARNESS,
  SCOUT_RUNTIME_EFFORT_CATALOG,
  SCOUT_RUNTIME_MODEL_CATALOG,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
} from "@openscout/protocol";
import {
  runtimeCatalogFromRunnerOptions,
  type RuntimeCatalog,
} from "./runtime-catalog.ts";

export type RuntimeCapabilityCatalog = {
  schemaVersion: "openscout.runtime-capabilities.v1";
  catalogVersion?: "openscout.runtime-catalog.v1";
  catalogRevision?: string;
  generatedAt?: number;
  scope?: "global" | "project" | "global+project";
  projectRoot?: string;
  defaults?: {
    harness?: string;
    model?: string | null;
    reasoningEffort?: string | null;
  };
  defaultsByHarness?: Partial<Record<string, {
    model?: string | null;
    reasoningEffort?: string | null;
  }>>;
  harnesses: Array<{ id: string; label?: string }>;
  models: Array<{ id: string; label?: string; description?: string; harnesses: string[] }>;
  efforts: Array<{
    id: string;
    label: string;
    description?: string;
    harnesses: string[];
    models?: string[];
  }>;
};

const SEED_DEFAULT_HARNESS = scoutRuntimeDefaultHarness() ?? "";
const SEED_DEFAULT_MODEL = scoutRuntimeDefaultModel(SEED_DEFAULT_HARNESS);

/** Cold-start seed only; a fetched versioned catalog replaces it. */
export const RUNTIME_CAPABILITY_SEED: RuntimeCapabilityCatalog = {
  schemaVersion: "openscout.runtime-capabilities.v1",
  catalogVersion: SCOUT_RUNTIME_CATALOG.schemaVersion,
  defaults: {
    harness: SEED_DEFAULT_HARNESS,
    model: SEED_DEFAULT_MODEL,
    reasoningEffort: scoutRuntimeDefaultReasoningEffort(
      SEED_DEFAULT_HARNESS,
      SEED_DEFAULT_MODEL,
    ),
  },
  defaultsByHarness: SCOUT_RUNTIME_DEFAULTS_BY_HARNESS,
  harnesses: SCOUT_RUNTIME_CATALOG.harnesses
    .filter((entry) => entry.enabled && entry.listed !== false)
    .map((entry) => ({ id: entry.id, label: entry.label })),
  models: SCOUT_RUNTIME_MODEL_CATALOG.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    harnesses: [...model.harnesses],
  })),
  efforts: SCOUT_RUNTIME_EFFORT_CATALOG.map((effort) => ({
    id: effort.id,
    label: effort.label,
    ...(effort.description ? { description: effort.description } : {}),
    harnesses: [...effort.harnesses],
    ...(effort.models ? { models: [...effort.models] } : {}),
  })),
};

/**
 * Fold the flat capability lists into the nested catalog the RuntimePicker
 * runs on. Same mapping as `runtimeCatalogFromRunnerOptions` — the capability
 * catalog simply has no readiness or description fields to carry over.
 */
export function runtimeCatalogFromCapabilities(
  catalog: RuntimeCapabilityCatalog,
): RuntimeCatalog {
  return runtimeCatalogFromRunnerOptions({
    defaultsByHarness: catalog.defaultsByHarness,
    harnesses: catalog.harnesses.map((candidate) => ({
      id: candidate.id,
      label: candidate.label ?? candidate.id,
    })),
    models: catalog.models.map((candidate) => ({
      id: candidate.id,
      label: candidate.label ?? candidate.id,
      description: candidate.description,
      harnesses: candidate.harnesses,
    })),
    efforts: catalog.efforts.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      description: candidate.description,
      harnesses: candidate.harnesses,
      ...(candidate.models?.length ? { models: [...candidate.models] } : {}),
    })),
  });
}

export function runtimeModelsForHarness(
  catalog: RuntimeCapabilityCatalog,
  harness: string,
): string[] {
  return catalog.models
    .filter((candidate) => candidate.harnesses.includes(harness))
    .map((candidate) => candidate.id);
}
