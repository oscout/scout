/**
 * Format a snake_case-ish identifier into a human-readable label.
 *
 * Replaces underscores with spaces. As a special case, the label
 * "relay agent" collapses to "agent" so UI surfaces don't surface the
 * relay implementation detail.
 *
 * Returns `null` when given `null`/`undefined`/empty string so callers
 * can chain with `??` fallbacks.
 */
export function formatLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/_/g, " ");
  if (cleaned.toLowerCase() === "relay agent") return "agent";
  return cleaned;
}
