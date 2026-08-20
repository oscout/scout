import { codexContextWindowTokens, isGpt5Family } from "./adapters/codex/context-window.js";
import { catalogContextWindowTokens } from "./model-catalog.js";
import { observedContextWindowTokens } from "./model-window-registry.js";

/** Conservative window for a fully unrecognized harness/model. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Unified context-window fallback for callers that don't know the adapter at
 * compile time — notably the web lane card (a {model, adapterType} string at
 * runtime, no adapter module).
 *
 * Precedence: a window learned from real logs (once per model) → Codex's
 * harness-specific cap (it exposes less than the model's raw window) → the
 * models.dev-generated per-model catalog (Claude per version, Grok, Gemini,
 * MiniMax…) → a conservative default. A transcript-logged window is preferred
 * upstream of all of this.
 */
export function inferModelContextWindowTokens(input: {
  model?: string | null;
  adapterType?: string | null;
}): number {
  const learned = observedContextWindowTokens(input.model);
  if (learned !== undefined) return learned;

  const adapterType = input.adapterType?.trim().toLowerCase() ?? "";
  // Codex caps below the model's raw window (its logged budget) — that wins.
  if (adapterType.includes("codex") || isGpt5Family(input.model)) {
    return codexContextWindowTokens(input.model);
  }

  // Per-model catalog (covers Claude per version, Grok, Gemini, MiniMax, …).
  return catalogContextWindowTokens(input.model) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}
