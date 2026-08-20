import { describe, expect, test } from "bun:test";
import {
  normalizeScoutAppearanceDetails,
  normalizeScoutThemeAccent,
  normalizeScoutThemeContrast,
  normalizeScoutThemePalette,
  normalizeScoutThemePreference,
  normalizeScoutShellStyle,
  normalizeScoutThemeTemplate,
  resolveScoutThemePreference,
} from "./theme.ts";

describe("Scout theme contract", () => {
  test("accepts only supported theme preferences", () => {
    expect(normalizeScoutThemePreference("system")).toBe("system");
    expect(normalizeScoutThemePreference("light")).toBe("light");
    expect(normalizeScoutThemePreference("dark")).toBe("dark");
    expect(normalizeScoutThemePreference("sepia")).toBeNull();
    expect(normalizeScoutThemePreference(null)).toBeNull();
  });

  test("accepts the supported palette, contrast, and accent axes", () => {
    expect(normalizeScoutShellStyle("scout")).toBe("scout");
    expect(normalizeScoutShellStyle("slack")).toBe("slack");
    expect(normalizeScoutShellStyle("teams")).toBeNull();
    expect(normalizeScoutThemePalette("scout")).toBe("scout");
    expect(normalizeScoutThemePalette("polar")).toBe("polar");
    expect(normalizeScoutThemePalette("catppuccin")).toBeNull();
    expect(normalizeScoutThemeContrast("strong")).toBe("strong");
    expect(normalizeScoutThemeContrast("maximum")).toBeNull();
    expect(normalizeScoutThemeAccent("theme")).toBe("theme");
    expect(normalizeScoutThemeAccent("cyan")).toBe("cyan");
    expect(normalizeScoutThemeAccent("rainbow")).toBeNull();
  });

  test("normalizes partial or stale appearance details to safe defaults", () => {
    expect(normalizeScoutAppearanceDetails({
      shell: "slack",
      palette: "graphite",
      contrast: "strong",
      accent: "violet",
    })).toEqual({
      shell: "slack",
      palette: "graphite",
      contrast: "strong",
      accent: "violet",
    });
    expect(normalizeScoutAppearanceDetails({
      shell: "removed-shell",
      palette: "removed-theme",
      contrast: "balanced",
    })).toEqual({
      shell: "scout",
      palette: "scout",
      contrast: "balanced",
      accent: "theme",
    });
  });

  test("accepts only Scout-supported Hudson templates", () => {
    expect(normalizeScoutThemeTemplate("hudson")).toBe("hudson");
    expect(normalizeScoutThemeTemplate("editorial")).toBe("editorial");
    expect(normalizeScoutThemeTemplate("drafting")).toBe("drafting");
    expect(normalizeScoutThemeTemplate("custom")).toBeNull();
  });

  test("resolves system preference without consulting browser globals", () => {
    expect(resolveScoutThemePreference("system", true)).toBe("dark");
    expect(resolveScoutThemePreference("system", false)).toBe("light");
    expect(resolveScoutThemePreference("light", true)).toBe("light");
    expect(resolveScoutThemePreference("dark", false)).toBe("dark");
  });
});
