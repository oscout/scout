/**
 * Codex context-window knowledge.
 *
 * Pure (no node deps) on purpose: this rides in the browser bundle via the
 * package `/client` entry, next to the web lane card. Keep it that way — the
 * adapter's `usage.ts` pulls in non-browser code, so window data lives here.
 *
 * The transcript-logged `model_context_window` (parsed in ./usage.ts) is ALWAYS
 * preferred; everything here is the fallback for rollouts that omit it.
 */

/**
 * Effective context window Codex exposes for the GPT-5.x family. This is NOT the
 * model's marketing total (~400k) — it's the usable input budget Codex reports
 * as `model_context_window` and uses for its own "% context left" readout.
 * Verified empirically across observed GPT-5.x Codex rollouts (gpt-5.5, gpt-5.4,
 * gpt-5.4-mini, gpt-5.3-codex, gpt-5.2-codex). Newer GPT-5.x ids use
 * the same fallback until Codex logs a different value.
 */
export const CODEX_GPT5_CONTEXT_WINDOW_TOKENS = 258_400;

/** True for the GPT-5.x model family ("gpt-5", "gpt-5.6-sol", "gpt-5.3-codex", …). */
export function isGpt5Family(model: string | null | undefined): boolean {
  return /^gpt-5(?:$|[.-])/u.test(normalizeCodexModel(model));
}

/**
 * Fallback context window for a Codex model when the rollout omits the logged
 * denominator. The whole observed Codex surface is the GPT-5.x family today, so
 * this is effectively constant; it stays model-aware so a future model with a
 * different window is a one-line change here, not in shared code.
 */
export function codexContextWindowTokens(_model?: string | null): number {
  return CODEX_GPT5_CONTEXT_WINDOW_TOKENS;
}

function normalizeCodexModel(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/_/gu, "-") ?? "";
}
