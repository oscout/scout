/**
 * Pierre/Shiki theme selection for repo diffs.
 *
 * The snapshot may hardcode `pierre-dark` (legacy server default). Embeds and
 * the macOS app pass the real UI mode via `?theme=light|dark` and
 * `data-scout-theme-mode` — we map that to a matching Pierre theme so the code
 * pane doesn't stay black in light mode next to native chrome.
 */

export type ScoutUiThemeMode = "light" | "dark";

const LIGHT_DEFAULT = "pierre-light";
const DARK_DEFAULT = "pierre-dark";

/** Active Scout UI mode from document markers / color-scheme (client only). */
export function readScoutUiThemeMode(
  doc: Pick<Document, "documentElement"> | null | undefined = typeof document === "undefined"
    ? null
    : document,
): ScoutUiThemeMode {
  if (!doc) return "dark";
  const root = doc.documentElement;
  const raw =
    root.dataset.scoutThemeMode ||
    root.dataset.scoutTheme ||
    root.getAttribute("data-scout-theme-mode") ||
    root.getAttribute("data-scout-theme") ||
    "";
  if (raw === "light" || raw === "dark") return raw;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

/**
 * Resolve the Pierre theme name used for highlighting.
 * - Honors explicit light/dark Pierre themes already on the snapshot.
 * - Remaps the historical `pierre-dark` / `github-dark` defaults when the UI is light.
 * - Falls back to pierre-light / pierre-dark for the active Scout mode.
 */
export function resolvePierreDiffTheme(
  preferred: string | null | undefined,
  mode: ScoutUiThemeMode = readScoutUiThemeMode(),
): string {
  const pref = (preferred ?? "").trim();
  if (pref.includes("light")) return pref || LIGHT_DEFAULT;
  if (mode === "light") {
    if (pref === "pierre-dark" || pref === "" || pref === DARK_DEFAULT) return LIGHT_DEFAULT;
    if (pref === "github-dark") return "github-light";
    if (pref.endsWith("-dark")) return pref.replace(/-dark$/, "-light");
    return LIGHT_DEFAULT;
  }
  if (pref) return pref;
  return DARK_DEFAULT;
}
