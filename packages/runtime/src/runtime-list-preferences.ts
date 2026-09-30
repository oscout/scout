/**
 * Runtime list preferences — fold the four configuration layers into the
 * ordered shortlist and preset arrays a picker consumes.
 *
 * Precedence, most specific first: project config → user config → the
 * harness's own on-disk preferences → broker runtime profiles (presets only).
 * Dedupe is `harness+model` for the shortlist and `id` for presets, keeping
 * the first — highest-precedence — occurrence.
 *
 * Entries whose harness is absent or disabled in the catalog are dropped with
 * a warning. Models unknown to the catalog are kept only for the project/user
 * origins (the picker already has a custom-model escape hatch); harness-native
 * models that don't match are dropped silently — they're another tool's
 * aliases, not operator intent.
 */

import {
  isScoutRuntimeHarnessEnabled,
  normalizeScoutReasoningEffort,
  parseScoutRuntimeSpec,
  type ScoutOwnedRuntimeCatalog,
} from "@openscout/protocol";
import type { BrokerRuntimeProfile } from "./broker-runtime-profiles.js";
import type { HarnessModelPreferenceMap } from "./harness-model-preferences.js";
import type { OpenScoutProjectConfig } from "./setup.js";
import type { OpenScoutUserConfig, RuntimePresetConfig } from "./user-config.js";

export type RuntimeShortlistOrigin =
  | "project"
  | "user"
  | "harness-favorite"
  | "harness-default"
  | "harness-recent";

export type RuntimePresetOrigin =
  | "project"
  | "user"
  | "harness-profile"
  | "broker-profile";

export interface ResolvedRuntimeShortlistEntry {
  harness: string;
  model: string;
  origin: RuntimeShortlistOrigin;
}

export interface ResolvedRuntimePreset {
  id: string;
  label: string;
  harness: string;
  model?: string;
  effort?: string;
  origin: RuntimePresetOrigin;
}

export interface ResolvedRuntimeListPreferences {
  shortlist: ResolvedRuntimeShortlistEntry[];
  presets: ResolvedRuntimePreset[];
  warnings: string[];
}

type ProjectRuntimeLists = NonNullable<NonNullable<OpenScoutProjectConfig["agent"]>["runtime"]>;

export function resolveRuntimeListPreferences(input: {
  catalog: ScoutOwnedRuntimeCatalog;
  user?: OpenScoutUserConfig;
  project?: ProjectRuntimeLists | null;
  harness?: HarnessModelPreferenceMap;
  brokerProfiles?: BrokerRuntimeProfile[];
}): ResolvedRuntimeListPreferences {
  const warnings: string[] = [];
  const shortlist: ResolvedRuntimeShortlistEntry[] = [];
  const presets: ResolvedRuntimePreset[] = [];
  const seenShortlist = new Set<string>();
  const seenPresets = new Set<string>();

  const catalog = input.catalog;
  const harnessEnabled = (harness: string): boolean =>
    isScoutRuntimeHarnessEnabled(harness, catalog);
  // When the catalog lists models for a harness it is the authority — a
  // harness-native id outside it is another tool's alias. When it lists none,
  // the harness takes free-form models and there is nothing to match against.
  const catalogModel = (harness: string, model: string): boolean => {
    const entry = catalog.harnesses.find((candidate) => candidate.id === harness);
    const enabled = entry?.models.filter((candidate) => candidate.enabled) ?? [];
    return enabled.length === 0 || enabled.some((candidate) => candidate.id === model);
  };

  const pushShortlist = (
    harness: string,
    model: string | undefined,
    origin: RuntimeShortlistOrigin,
  ): void => {
    if (!model) return; // a bare harness spec pins nothing
    if (!harnessEnabled(harness)) {
      warnings.push(`runtime shortlist entry "${harness}/${model}" ignored — harness "${harness}" is not enabled in the catalog`);
      return;
    }
    if (origin.startsWith("harness-") && !catalogModel(harness, model)) {
      return; // another harness tool's alias — drop silently
    }
    const key = `${harness}\n${model}`;
    if (seenShortlist.has(key)) return;
    seenShortlist.add(key);
    shortlist.push({ harness, model, origin });
  };

  const pushPreset = (
    preset: { id: string; label: string; harness: string; model?: string; effort?: string },
    origin: RuntimePresetOrigin,
  ): void => {
    if (!preset.id || seenPresets.has(preset.id)) return;
    if (!harnessEnabled(preset.harness)) {
      warnings.push(`runtime preset "${preset.id}" ignored — harness "${preset.harness}" is not enabled in the catalog`);
      return;
    }
    if (origin === "harness-profile" && preset.model && !catalogModel(preset.harness, preset.model)) {
      return; // profile names another tool's model id — drop silently
    }
    seenPresets.add(preset.id);
    presets.push({
      id: preset.id,
      label: preset.label || preset.id,
      harness: preset.harness,
      ...(preset.model ? { model: preset.model } : {}),
      ...(preset.effort ? { effort: preset.effort } : {}),
      origin,
    });
  };

  const pushSpecShortlist = (specs: string[] | undefined, origin: "project" | "user"): void => {
    for (const spec of specs ?? []) {
      const parsed = parseScoutRuntimeSpec(spec);
      if (!parsed.ok) {
        warnings.push(`runtime shortlist spec "${spec}" ignored: ${parsed.error}`);
        continue;
      }
      pushShortlist(parsed.value.harness, parsed.value.model, origin);
    }
  };

  const pushSpecPresets = (
    items: RuntimePresetConfig[] | undefined,
    origin: "project" | "user",
  ): void => {
    for (const item of items ?? []) {
      const parsed = parseScoutRuntimeSpec(item?.runtime ?? "");
      if (!parsed.ok) {
        warnings.push(`runtime preset "${item?.id ?? "?"}" ignored: ${parsed.error}`);
        continue;
      }
      pushPreset({
        id: item.id,
        label: item.label?.trim() || item.id,
        harness: parsed.value.harness,
        model: parsed.value.model,
        effort: parsed.value.reasoningEffort,
      }, origin);
    }
  };

  pushSpecShortlist(input.project?.shortlist, "project");
  pushSpecShortlist(input.user?.runtimeShortlist, "user");
  for (const [harnessId, prefs] of Object.entries(input.harness ?? {})) {
    if (!prefs) continue;
    for (const model of prefs.favorites ?? []) pushShortlist(harnessId, model, "harness-favorite");
    if (prefs.defaultModel) pushShortlist(harnessId, prefs.defaultModel, "harness-default");
    for (const model of prefs.recent ?? []) pushShortlist(harnessId, model, "harness-recent");
  }

  pushSpecPresets(input.project?.presets, "project");
  pushSpecPresets(input.user?.runtimePresets, "user");
  for (const [harnessId, prefs] of Object.entries(input.harness ?? {})) {
    for (const profile of prefs?.profiles ?? []) {
      pushPreset({
        id: profile.id,
        label: profile.label || profile.id,
        harness: harnessId,
        model: profile.model,
        effort: profile.effort ? normalizeScoutReasoningEffort(profile.effort) ?? undefined : undefined,
      }, "harness-profile");
    }
  }
  // `oc` is the `opencode` alias — both resolve to the same broker profile, so
  // the canonical id is the only one that becomes a preset.
  const brokerIds = new Set((input.brokerProfiles ?? []).map((profile) => profile.id));
  for (const profile of input.brokerProfiles ?? []) {
    if (profile.id === "oc" && brokerIds.has("opencode")) continue;
    pushPreset({
      id: profile.id,
      label: profile.displayName,
      harness: profile.execution.harness ?? "",
      model: profile.execution.model,
      effort: profile.execution.reasoningEffort
        ? normalizeScoutReasoningEffort(profile.execution.reasoningEffort) ?? undefined
        : undefined,
    }, "broker-profile");
  }

  return { shortlist, presets, warnings };
}
