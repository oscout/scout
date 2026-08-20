import { catalogContextWindowTokens } from "../../model-catalog.js";

/** Conservative fallback when even the catalog doesn't recognize the model. */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** True for an Anthropic/Claude model id ("claude-opus-5", "sonnet", …). */
export function isClaudeModel(model: string | null | undefined): boolean {
  return /opus|sonnet|haiku|claude/u.test(model?.trim().toLowerCase() ?? "");
}

/**
 * Context window for a model seen on a claude-code lane. Resolved PER VERSION
 * from the catalog — opus-4-8 → 1M but opus-4-5 → 200k, sonnet-4-6 → 1M but
 * sonnet-4-5 → 200k — which a flat "opus → 1M" family rule gets wrong. The
 * catalog also covers guest models (e.g. Grok) that ride the claude-code log
 * mixed in with native Claude turns. Falls back to the conservative default.
 *
 * NOTE: Claude transcripts never carry a logged window, so this catalog lookup
 * is the ONLY source for Claude — there is nothing to learn from the logs.
 */
export function claudeContextWindowTokens(model?: string | null): number {
  return catalogContextWindowTokens(model) ?? CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
}
