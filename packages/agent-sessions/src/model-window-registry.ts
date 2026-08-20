/**
 * Per-model context-window registry — learned from observed transcripts.
 *
 * Some harnesses log `model_context_window` (Codex does, ~every event); others
 * never do (Claude). When a harness DOES report a window, we record it here once
 * per model, so the value comes from real data instead of a baked-in constant —
 * and a model whose provider changes its window is tracked automatically rather
 * than going stale. The hard-coded per-adapter tables remain only as the floor
 * for models we've never observed with a logged window (e.g. all of Claude).
 *
 * Deliberately "once per model" (first non-zero wins): we don't re-learn on every
 * event or session — once we know a model's window, that's enough.
 *
 * Pure (no node deps) so it can ride in the browser bundle via `/client`; the
 * map is process-local and simply stays empty where nothing records into it.
 */

const observed = new Map<string, number>();

function normalizeModel(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/_/gu, "-") ?? "";
}

/** Record a window observed from a transcript. First non-zero value per model
 *  wins; later observations and zero/invalid values are ignored. */
export function recordObservedContextWindow(
  model: string | null | undefined,
  windowTokens: number | null | undefined,
): void {
  const key = normalizeModel(model);
  if (!key) return;
  if (typeof windowTokens !== "number" || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return;
  }
  if (!observed.has(key)) {
    observed.set(key, windowTokens);
  }
}

/** The learned window for a model, or undefined if none has been observed. */
export function observedContextWindowTokens(
  model: string | null | undefined,
): number | undefined {
  const key = normalizeModel(model);
  if (!key) return undefined;
  return observed.get(key);
}

/** Test seam — drop all learned windows. */
export function clearObservedContextWindows(): void {
  observed.clear();
}
