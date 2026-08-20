import { MODEL_CONTEXT_WINDOWS } from "./model-windows.generated.js";
import { RUNTIME_MODEL_CONTEXT_WINDOWS } from "./runtime-model-windows.generated.js";

const liveRuntimeModelContextWindows: Record<string, number> = {
  ...RUNTIME_MODEL_CONTEXT_WINDOWS,
};

export function applyRuntimeModelContextWindows(windows: Readonly<Record<string, number>>): void {
  for (const key of Object.keys(liveRuntimeModelContextWindows)) delete liveRuntimeModelContextWindows[key];
  for (const [model, tokens] of Object.entries(windows)) {
    if (Number.isInteger(tokens) && tokens > 0) liveRuntimeModelContextWindows[canonical(model)] = tokens;
  }
}

/**
 * Per-model context-window lookup, backed by the models.dev-generated catalog
 * (model-windows.generated.ts) with a tiny hand-override layer on top.
 *
 * Pure (no node deps) so it rides the browser bundle via `/client`.
 *
 * Precedence elsewhere: a transcript-logged window, the learned registry, and
 * harness-specific caps (Codex) all sit ABOVE this; this is the raw per-model
 * fallback. Window is per *version*, not per family — opus-4-8 is 1M but
 * opus-4-5 is 200k — which is exactly why a catalog beats family rules.
 */

/**
 * Hand overrides — win over the generated catalog. For (a) models absent from
 * the checked-in native catalog, including newly released and aggregator-only
 * models, and (b) known catalog errors. Keep this tiny; prefer fixing the
 * generator. This is also the trust valve: if models.dev ever gets a model
 * wrong, pin it here.
 */
export const MODEL_WINDOW_OVERRIDES: Record<string, number> = {
  // Released after the checked-in models.dev snapshot.
  "claude-opus-5": 1_000_000,
  // Grok variants carried only by aggregator providers (not under xai natively).
  "grok-4": 256_000,
  "grok-code-fast-1": 256_000,
};

/** Canonicalize a model id for matching: lower-case, strip a provider prefix
 *  ("anthropic/…", pi-style) and a trailing ":effort", fold "."/"_" → "-". */
function canonical(model: string | null | undefined): string {
  let m = model?.trim().toLowerCase() ?? "";
  if (!m) return "";
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/:[a-z0-9-]+$/u, "");
  return m.replace(/[._]/gu, "-");
}

/** The catalog/override context window for a model id, or undefined if unknown. */
export function catalogContextWindowTokens(model: string | null | undefined): number | undefined {
  const key = canonical(model);
  if (!key) return undefined;
  return MODEL_WINDOW_OVERRIDES[key] ?? liveRuntimeModelContextWindows[key] ?? MODEL_CONTEXT_WINDOWS[key];
}
