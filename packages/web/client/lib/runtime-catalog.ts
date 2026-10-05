import {
  SCOUT_REASONING_EFFORT_LABELS,
  SCOUT_REASONING_EFFORTS,
  type ScoutReasoningEffort,
} from "@openscout/protocol";

/**
 * Runtime catalog — the data half of the RuntimePicker atom.
 *
 * Ported from `design/studio/lib/runtime-catalog.ts`. The rules that are NOT
 * the caller's problem live here — reconciliation when the harness changes,
 * effort capability, the custom-model escape hatch — because every consumer
 * was otherwise reimplementing them slightly differently (the New task modal
 * kept a cross-listed model on harness switch; the home composer reset to the
 * first listed one).
 *
 * Unlike the studio module there is no fixture catalog: production always
 * builds one from live data. `runtimeCatalogFromRunnerOptions()` accepts the
 * `/api/runner/options` shape (and anything structurally similar);
 * `runtimeCatalogFromCapabilities()` in `runtime-capabilities.ts` covers the
 * versioned capability catalog the home composer uses.
 */

export interface RuntimeOption {
  value: string;
  label: string;
  /** Trailing micro-caption on the row. One or two words, never a sentence. */
  note?: string;
  /** Listed but unselectable. A harness that isn't installed is information. */
  disabled?: boolean;
}

export interface RuntimeEffort extends RuntimeOption {
  /**
   * Model ids this rung is restricted to, scoped per harness. A rung is
   * withheld from a selected model only when the model's own harness has at
   * least one catalog model named here and the selection is not among them —
   * so `models: ["gpt-5.6-sol", …]` narrows Codex's ladder without touching
   * Claude's. Default/unknown models see the full harness ladder.
   */
  models?: string[];
}

export interface RuntimeHarness extends RuntimeOption {
  models: RuntimeOption[];
  /** Scout-owned defaults for this harness, independent of vendor metadata. */
  defaultModel?: string;
  defaultEffort?: string;
  /**
   * `null` means this harness has no effort concept at all — not "use the
   * default". Some harnesses reject effort until their transports expose the
   * control, so the picker drops the band rather than showing a dial that
   * goes nowhere. `undefined` falls back to the catalog ladder.
   */
  efforts?: RuntimeEffort[] | null;
}

/**
 * Where a pinned model came from, most specific first. `project`/`user` are
 * configured lists; the `harness-*` origins are the harness's own on-disk
 * preferences observed read-only.
 */
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

export interface RuntimeShortlistEntry {
  harness: string;
  model: string;
  origin: RuntimeShortlistOrigin;
}

/** One named `<harness>[/<model>[/<effort>]]` tuple — a chip in the picker. */
export interface RuntimePreset {
  id: string;
  label: string;
  harness: string;
  model?: string;
  effort?: string;
  origin: RuntimePresetOrigin;
}

export interface RuntimeCatalog {
  harnesses: RuntimeHarness[];
  /** Fallback ladder for harnesses that don't name their own. Ordinal. */
  efforts: RuntimeEffort[];
  /** Models pinned first in the Model band; everything else stays visible. */
  shortlist?: RuntimeShortlistEntry[];
  /** Named runtime tuples rendered as a band above Harness. */
  presets?: RuntimePreset[];
}

export interface RuntimeValue {
  harness: string;
  model: string;
  effort: string;
}

/** `""` keeps its production meaning throughout: let the harness decide. */
export const RUNTIME_DEFAULT_VALUE = "";

/**
 * The ladder is ordinal, which is why the panel draws it as a filling meter
 * rather than a list. Notes name the intent, not the token spend. This is the
 * production 8-rung ladder (superset of the studio fixture's four); live
 * catalogs are capability-filtered per harness before they reach the picker.
 */
const RUNTIME_EFFORT_NOTES: Readonly<Record<ScoutReasoningEffort, string>> = {
  none: "no reasoning",
  minimal: "lightest",
  low: "triage",
  medium: "default",
  high: "deep",
  xhigh: "exhaustive",
  max: "fullest",
  ultra: "beyond max",
};

export const RUNTIME_EFFORTS: RuntimeEffort[] = SCOUT_REASONING_EFFORTS.map((value) => ({
  value,
  label: SCOUT_REASONING_EFFORT_LABELS[value],
  note: RUNTIME_EFFORT_NOTES[value],
}));

// ── Lookups ──────────────────────────────────────────────────────────────────

export function harnessFor(
  catalog: RuntimeCatalog,
  harness: string,
): RuntimeHarness | undefined {
  return catalog.harnesses.find((entry) => entry.value === harness);
}

export function modelsFor(catalog: RuntimeCatalog, harness: string): RuntimeOption[] {
  return harnessFor(catalog, harness)?.models ?? [];
}

/**
 * `null` when the harness has no effort concept — see `RuntimeHarness.efforts`.
 *
 * With a `model`, the ladder narrows to what that model actually accepts:
 * rungs carry a per-harness model restriction (see `RuntimeEffort.models`),
 * so `ultra` shows for `gpt-5.6-sol` but not for `gpt-5.5`. Default and
 * custom (unlisted) models get the full harness ladder — there is nothing
 * accurate to narrow them by.
 */
export function effortsFor(
  catalog: RuntimeCatalog,
  harness: string,
  model?: string,
): RuntimeEffort[] | null {
  const entry = harnessFor(catalog, harness);
  if (harness === "codex" && model === RUNTIME_DEFAULT_VALUE) return [];
  const ladder = !entry
    ? catalog.efforts
    : entry.efforts === null
      ? null
      : entry.efforts ?? catalog.efforts;
  if (!ladder || !model) return ladder;
  const harnessModels = new Set((entry?.models ?? []).map((option) => option.value));
  if (!harnessModels.has(model)) return ladder;
  return ladder.filter((step) => {
    if (!step.models || step.models.length === 0) return true;
    const scoped = step.models.filter((id) => harnessModels.has(id));
    return scoped.length === 0 || scoped.includes(model);
  });
}

export function supportsEffort(catalog: RuntimeCatalog, harness: string): boolean {
  return effortsFor(catalog, harness) !== null;
}

/**
 * Pin-first ordering for the Model band: shortlisted models for `harness`
 * lead in shortlist order, then a divider, then everything else in catalog
 * order. `""` (the Default row) is never pinned — it is not a model — and a
 * shortlisted id the catalog does not list still pins, marked `custom`, since
 * the operator named it deliberately.
 */
export interface PinnedRuntimeOption extends RuntimeOption {
  pinnedOrigin: RuntimeShortlistOrigin;
}

export function orderModelsWithShortlist(
  models: RuntimeOption[],
  shortlist: RuntimeShortlistEntry[] | undefined,
  harness: string,
): { pinned: PinnedRuntimeOption[]; rest: RuntimeOption[] } {
  const pins = (shortlist ?? []).filter(
    (entry) => entry.harness === harness && entry.model,
  );
  if (!pins.length) return { pinned: [], rest: models };
  const pinnedValues = new Set<string>();
  const pinned: PinnedRuntimeOption[] = [];
  for (const entry of pins) {
    if (pinnedValues.has(entry.model)) continue;
    pinnedValues.add(entry.model);
    const listed = models.find((option) => option.value === entry.model);
    pinned.push({
      ...(listed ?? { value: entry.model, label: entry.model, note: "custom" }),
      pinnedOrigin: entry.origin,
    });
  }
  const rest = models.filter((option) => !pinnedValues.has(option.value));
  return { pinned, rest };
}

/**
 * The preset matching the current value: harness and model must be exact; a
 * preset that names an effort also requires that rung, while one without an
 * effort matches any rung — it prescribes nothing there.
 */
export function matchPreset(
  catalog: RuntimeCatalog,
  value: RuntimeValue,
): RuntimePreset | undefined {
  return catalog.presets?.find((preset) => {
    if (preset.harness !== value.harness) return false;
    if ((preset.model ?? RUNTIME_DEFAULT_VALUE) !== value.model) return false;
    if (preset.effort !== undefined && preset.effort !== value.effort) return false;
    return true;
  });
}

/**
 * The value a preset stands for. Reconciled against the current value so an
 * effort the harness ladder cannot express clamps rather than passing through.
 * A preset that names no effort applies the harness default instead of
 * carrying the previous rung.
 */
export function valueForPreset(
  catalog: RuntimeCatalog,
  preset: RuntimePreset,
  current: RuntimeValue,
): RuntimeValue {
  return reconcileRuntime(catalog, current, {
    harness: preset.harness,
    model: preset.model ?? RUNTIME_DEFAULT_VALUE,
    ...(preset.effort !== undefined ? { effort: preset.effort } : {}),
  });
}

/** Display name for a shortlist/preset origin — chip titles and pinned rows. */
export function runtimeListOriginLabel(
  origin: RuntimeShortlistOrigin | RuntimePresetOrigin,
  harnessLabel?: string,
  kind: "shortlist" | "preset" = "shortlist",
): string {
  switch (origin) {
    case "project": return kind === "preset" ? "Project preset" : "Project shortlist";
    case "user": return kind === "preset" ? "Your preset" : "Your shortlist";
    case "harness-favorite": return `${harnessLabel ?? "Harness"} favorite`;
    case "harness-default": return `${harnessLabel ?? "Harness"} default`;
    case "harness-recent": return `${harnessLabel ?? "Harness"} recent`;
    case "harness-profile": return `${harnessLabel ?? "Harness"} profile`;
    case "broker-profile": return "Broker profile";
  }
}

/**
 * The model in `value` may not be in the catalog: surfaces accept free text
 * so an operator can name a model the snapshot hasn't seen yet. Rather than
 * silently showing "Default" — which would be a lie about what is about to
 * run — an unknown id comes back as its own option, marked.
 */
export function resolveModel(
  catalog: RuntimeCatalog,
  value: RuntimeValue,
): RuntimeOption {
  const models = modelsFor(catalog, value.harness);
  const hit = models.find((model) => model.value === value.model);
  if (hit) return hit;
  if (value.model.trim()) {
    return { value: value.model, label: value.model, note: "custom" };
  }
  return { value: RUNTIME_DEFAULT_VALUE, label: "Default", note: "harness picks" };
}

export interface RuntimeDescription {
  harness: RuntimeOption | undefined;
  harnessLabel: string;
  model: RuntimeOption;
  modelLabel: string;
  effort: RuntimeOption | undefined;
  effortLabel: string;
  supportsEffort: boolean;
  /** Ready-made for `aria-label` on a collapsed trigger. */
  summary: string;
}

export function describeRuntime(
  catalog: RuntimeCatalog,
  value: RuntimeValue,
): RuntimeDescription {
  const harness = harnessFor(catalog, value.harness);
  const harnessLabel = harness?.label ?? value.harness ?? "Default";
  const model = resolveModel(catalog, value);
  const efforts = effortsFor(catalog, value.harness, value.model);
  const effort = efforts?.find((step) => step.value === value.effort);
  const effortLabel = effort?.label ?? value.effort;
  const summary = efforts
    ? `Runtime: ${harnessLabel}, model ${model.label}, effort ${effortLabel}`
    : `Runtime: ${harnessLabel}, model ${model.label}`;
  return {
    harness,
    harnessLabel,
    model,
    modelLabel: model.label,
    effort,
    effortLabel,
    supportsEffort: efforts !== null,
    summary,
  };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Apply a patch and repair whatever it invalidated.
 *
 * Changing harness resets the model to Default rather than guessing a
 * cross-vendor equivalent — carrying `claude-opus-5` over to Codex would be a
 * silent lie about what runs. Effort survives when the new harness has the same
 * rung, clamps to the top of a shorter ladder, and empties when the new harness
 * has no effort control at all. Changing only the model keeps the rung when the
 * new model still offers it and clamps by position when the ladder narrows
 * (`ultra` on `gpt-5.6-sol` becomes `xhigh` on `gpt-5.5`).
 *
 * Every consumer needs this and none of them should be writing it.
 */
export function reconcileRuntime(
  catalog: RuntimeCatalog,
  value: RuntimeValue,
  patch: Partial<RuntimeValue>,
): RuntimeValue {
  const next: RuntimeValue = { ...value, ...patch };
  const harnessChanged = patch.harness !== undefined && patch.harness !== value.harness;
  if (next.harness === "codex" && next.model === RUNTIME_DEFAULT_VALUE && !harnessChanged) {
    return { ...next, effort: RUNTIME_DEFAULT_VALUE };
  }
  if (!harnessChanged) {
    if (patch.model === undefined || patch.model === value.model) return next;
    // Model-only change: the ladder may narrow (ultra exists on some Codex
    // models only). A still-valid rung survives; an out-of-range one clamps
    // by position, same as a harness switch. "" means "harness decides" and
    // always survives.
    const narrowed = effortsFor(catalog, next.harness, next.model);
    if (!narrowed || next.effort === RUNTIME_DEFAULT_VALUE) return next;
    if (narrowed.some((step) => step.value === next.effort)) return next;
    const wide = effortsFor(catalog, value.harness, value.model) ?? catalog.efforts;
    const wideIndex = wide.findIndex((step) => step.value === value.effort);
    const clampedIndex = Math.min(Math.max(wideIndex, 0), narrowed.length - 1);
    next.effort =
      narrowed[clampedIndex]?.value ?? narrowed[0]?.value ?? RUNTIME_DEFAULT_VALUE;
    return next;
  }

  const nextHarness = harnessFor(catalog, next.harness);
  next.model = patch.model ?? nextHarness?.defaultModel ?? RUNTIME_DEFAULT_VALUE;
  if (patch.effort === undefined && nextHarness?.defaultEffort) {
    next.effort = nextHarness.defaultEffort;
  }

  const efforts = effortsFor(catalog, next.harness, next.model);
  if (!efforts) {
    next.effort = RUNTIME_DEFAULT_VALUE;
    return next;
  }
  if (efforts.some((step) => step.value === next.effort)) return next;

  // Same rung by position, clamped — "high" on a 3-rung ladder stays the top
  // rung rather than falling back to the middle.
  const previous = effortsFor(catalog, value.harness, value.model) ?? catalog.efforts;
  const index = previous.findIndex((step) => step.value === value.effort);
  const clamped = Math.min(Math.max(index, 0), efforts.length - 1);
  next.effort = efforts[clamped]?.value ?? efforts[0]?.value ?? RUNTIME_DEFAULT_VALUE;
  return next;
}

/** Seed an uncontrolled picker without demanding all three fields. */
export function seedRuntime(
  catalog: RuntimeCatalog,
  seed?: Partial<RuntimeValue>,
): RuntimeValue {
  const harness =
    seed?.harness ?? catalog.harnesses.find((entry) => !entry.disabled)?.value ?? "";
  const efforts = effortsFor(catalog, harness);
  const fallbackEffort =
    efforts?.find((step) => step.note === "default")?.value ??
    efforts?.[Math.floor((efforts.length - 1) / 2)]?.value ??
    RUNTIME_DEFAULT_VALUE;
  const model = seed?.model
      ?? harnessFor(catalog, harness)?.defaultModel
      ?? modelsFor(catalog, harness)[1]?.value
      ?? RUNTIME_DEFAULT_VALUE;
  return {
    harness,
    model,
    effort: harness === "codex" && model === RUNTIME_DEFAULT_VALUE ? RUNTIME_DEFAULT_VALUE : efforts
      ? (seed?.effort ?? harnessFor(catalog, harness)?.defaultEffort ?? fallbackEffort)
      : RUNTIME_DEFAULT_VALUE,
  };
}

// ── Filtering ────────────────────────────────────────────────────────────────

/**
 * Substring match across label, value and note. Not fuzzy: a model list is
 * short and precise, and fuzzy matching on ids like `gpt-5` vs `gpt-5.5`
 * reorders the two in ways that read as a bug.
 */
export function searchRuntimeOptions(
  options: RuntimeOption[],
  query: string,
): RuntimeOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    `${option.label} ${option.value} ${option.note ?? ""}`.toLowerCase().includes(needle),
  );
}

// ── Builders ─────────────────────────────────────────────────────────────────

/**
 * Structural view of `/api/runner/options` (see `RunnerOptionsState` in
 * `NewChatComposer.tsx`). Declared here so the builder is testable without
 * importing a screen.
 */
export interface RunnerOptionsLike {
  defaultsByHarness?: Partial<Record<string, {
    model?: string | null;
    reasoningEffort?: string | null;
  }>>;
  harnesses: Array<{
    id: string;
    label: string;
    description?: string | null;
    state?: string | null;
    ready?: boolean | null;
    detail?: string | null;
  }>;
  models: Array<{
    id: string;
    label: string;
    description?: string | null;
    harnesses: string[];
  }>;
  efforts: Array<{
    id: string;
    label: string;
    description?: string | null;
    harnesses: string[];
    models?: string[];
  }>;
  /** Resolved runtime lists — see `resolveRuntimeListPreferences` upstream. */
  shortlist?: RuntimeShortlistEntry[];
  presets?: RuntimePreset[];
}

function noteFrom(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Fold the flat runner/capability lists — where models and efforts name the
 * harnesses they belong to — into the nested catalog the picker runs on. A
 * harness with zero effort candidates gets `efforts: null`: no ladder at all,
 * not an empty one. Unready harnesses stay listed but unselectable, carrying
 * their reason as a note.
 */
export function runtimeCatalogFromRunnerOptions(options: RunnerOptionsLike): RuntimeCatalog {
  const harnesses: RuntimeHarness[] = options.harnesses.map((harness) => {
    const harnessDefaults = options.defaultsByHarness?.[harness.id];
    const ready = harness.ready !== false;
    const models: RuntimeOption[] = [
      { value: RUNTIME_DEFAULT_VALUE, label: "Default", note: "harness picks" },
      ...options.models
        .filter((candidate) => candidate.harnesses.includes(harness.id))
        .map((candidate) => ({
          value: candidate.id,
          label: candidate.label,
          note: noteFrom(candidate.description),
        })),
    ];
    const supported = options.efforts.filter((candidate) =>
      candidate.harnesses.includes(harness.id),
    );
    return {
      value: harness.id,
      label: harness.label,
      note: ready ? noteFrom(harness.description) : noteFrom(harness.detail, harness.state, "unavailable"),
      disabled: !ready,
      defaultModel: harnessDefaults?.model ?? RUNTIME_DEFAULT_VALUE,
      defaultEffort: harnessDefaults?.reasoningEffort ?? RUNTIME_DEFAULT_VALUE,
      models,
      efforts: supported.length === 0
        ? null
        : supported.map((candidate) => ({
            value: candidate.id,
            label: candidate.label,
            note: noteFrom(candidate.description),
            ...(candidate.models?.length ? { models: [...candidate.models] } : {}),
          })),
    };
  });
  const efforts: RuntimeOption[] = options.efforts.map((candidate) => ({
    value: candidate.id,
    label: candidate.label,
    note: noteFrom(candidate.description),
  }));
  return {
    harnesses,
    efforts: efforts.length > 0 ? efforts : RUNTIME_EFFORTS,
    ...(options.shortlist?.length ? { shortlist: options.shortlist } : {}),
    ...(options.presets?.length ? { presets: options.presets } : {}),
  };
}
