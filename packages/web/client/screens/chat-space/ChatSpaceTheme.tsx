/**
 * Theme host for the standalone chat surfaces.
 *
 * `/chat` and `/invite/<token>` deliberately do not mount the operator shell
 * or `ScoutProvider` — a teammate's member cookie cannot make the operator
 * API calls that provider fires, and an invitation page must render before any
 * of them. But the surface must still be the same Scout: the `[data-scout-theme]`
 * alias layer in `app.css` maps `--bg` and friends onto the `--hud-*` tokens,
 * and `var()` resolves where it is declared, so the element that carries the
 * attribute has to carry the token values too. That is all this component is.
 *
 * Nothing here hard-codes a color: the maps come from `scout/Provider.tsx`, so
 * a palette or accent change moves these surfaces with the rest of the app.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { DARK_THEME_VARS, LIGHT_THEME_VARS } from "../../scout/Provider.tsx";
import {
  applyScoutThemeToDocument,
  resolveScoutNativeThemeVars,
  resolveScoutStartupAppearanceDetails,
  resolveScoutStartupTemplate,
  resolveScoutStartupTheme,
  resolveScoutStartupThemePreference,
  resolveScoutThemePreference,
  writeScoutThemePreference,
  type ScoutTheme,
  type ScoutThemePreference,
} from "../../lib/theme.ts";

import "./chat-space.css";

export interface ScoutStandaloneAppearance {
  /** What is on screen right now. */
  theme: ScoutTheme;
  /** What the viewer asked for, which may be "system". */
  preference: ScoutThemePreference;
  setPreference: (next: ScoutThemePreference) => void;
}

export function useScoutStandaloneAppearance(): ScoutStandaloneAppearance {
  const [preference, setStatedPreference] = useState<ScoutThemePreference>(
    () => resolveScoutStartupThemePreference(),
  );
  const [theme, setTheme] = useState<ScoutTheme>(() => resolveScoutStartupTheme());

  useEffect(() => {
    applyScoutThemeToDocument(
      theme,
      resolveScoutStartupTemplate(),
      resolveScoutStartupAppearanceDetails(),
    );
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(resolveScoutThemePreference(preference));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ScoutThemePreference) => {
    writeScoutThemePreference(next);
    setStatedPreference(next);
    setTheme(resolveScoutThemePreference(next));
  }, []);

  return { theme, preference, setPreference };
}

export function useScoutStandaloneTheme(): ScoutTheme {
  return useScoutStandaloneAppearance().theme;
}

export function ChatSpaceTheme({
  theme,
  className,
  compactView,
  railed,
  children,
}: {
  theme: ScoutTheme;
  className: string;
  /** Drives the compact single-pane stack in CSS; ignored above 900px. */
  compactView?: "list" | "channel" | "panel";
  /**
   * Collapsed sidebar. It is stamped here rather than on the body because the
   * topbar is the sidebar's header band and has to measure itself against the
   * same `--sidebar-w` the grid below uses.
   */
  railed?: boolean;
  children: ReactNode;
}) {
  // A native host (WKWebView) passes its resolved palette on the query string;
  // it layers over the web defaults exactly as it does for the embed surfaces.
  const nativeVars = useMemo(() => resolveScoutNativeThemeVars(), []);
  const style = useMemo(
    () => ({
      ...(theme === "light" ? LIGHT_THEME_VARS : DARK_THEME_VARS),
      ...(nativeVars ?? {}),
    }) as CSSProperties,
    [theme, nativeVars],
  );
  return (
    <div
      className={className}
      data-scout-theme={theme}
      data-scout-theme-mode={theme}
      {...(compactView ? { "data-compact-view": compactView } : {})}
      {...(railed ? { "data-rail": "true" } : {})}
      style={style}
    >
      {children}
    </div>
  );
}
