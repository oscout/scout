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
 * GPT-5-specific cap (it exposes less than those models' raw windows) → the
 * models.dev-generated per-model catalog (GPT-6, Claude per version, Grok,
 * Gemini, MiniMax…) → a conservative default. A transcript-logged window is
 * preferred upstream of all of this.
 */
export function inferModelContextWindowTokens(input: {
  model?: string | null;
  adapterType?: string | null;
}): number {
  const learned = observedContextWindowTokens(input.model);
  if (learned !== undefined) return learned;

  const adapterType = input.adapterType?.trim().toLowerCase() ?? "";
  const catalogWindow = catalogContextWindowTokens(input.model);
  const normalizedModel = (input.model?.trim().toLowerCase().split("/").at(-1) ?? "")
    .replace(/:[a-z0-9-]+$/u, "")
    .replace(/_/gu, "-");
  const isGpt6Family = /^gpt-6(?:$|[.-])/u.test(normalizedModel);
  // Codex capped the GPT-5 family below its raw advertised window. Keep that
  // established adapter fallback for other models, but let GPT-6 use its own
  // catalog card.
  if (isGpt5Family(input.model) || (adapterType.includes("codex") && !isGpt6Family)) {
    return codexContextWindowTokens(input.model);
  }

  // Per-model catalog (covers Claude per version, Grok, Gemini, MiniMax, …).
  return catalogWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}
