import { describe, expect, test } from "bun:test";
import {
  SCOUT_THEME_STORAGE_KEY,
  migrateLegacyAgentCharacters,
  normalizeScoutAppearanceDetails,
  normalizeScoutAvatarSize,
  normalizeScoutThemeAccent,
  normalizeScoutThemeContrast,
  normalizeScoutThemePalette,
  normalizeScoutThemePreference,
  normalizeScoutShellStyle,
  normalizeScoutThemeTemplate,
  resolveScoutThemePreference,
  resolveAgentCharacterAssignment,
  writeScoutAppearanceDetails,
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
    expect(normalizeScoutAvatarSize("compact")).toBe("compact");
    expect(normalizeScoutAvatarSize("large")).toBe("large");
    expect(normalizeScoutAvatarSize("huge")).toBeNull();
  });

  test("normalizes partial or stale appearance details to safe defaults", () => {
    expect(normalizeScoutAppearanceDetails({
      shell: "slack",
      palette: "graphite",
      contrast: "strong",
      accent: "violet",
      avatarStyle: "crew",
      avatarSize: "large",
      operatorCharacter: "brik",
      agentCharacters: { "codex-here": "vex", Sprout: "sprout", ghost: "not-a-cast-member" },
    })).toEqual({
      shell: "slack",
      palette: "graphite",
      contrast: "strong",
      accent: "violet",
      avatarStyle: "crew",
      avatarSize: "large",
      operatorCharacter: "brik",
      agentCharacters: {
        byId: {},
        legacyByName: { "codex-here": "vex", sprout: "sprout" },
      },
    });
    expect(normalizeScoutAppearanceDetails({
      shell: "removed-shell",
      palette: "removed-theme",
      contrast: "balanced",
      agentCharacters: { stray: 42 },
    })).toEqual({
      shell: "scout",
      palette: "scout",
      contrast: "balanced",
      accent: "theme",
      avatarStyle: "crew",
      avatarSize: "regular",
      operatorCharacter: "milo",
      agentCharacters: { byId: {}, legacyByName: {} },
    });
  });

  test("migrates a legacy name only when it identifies one durable agent", () => {
    const legacy = normalizeScoutAppearanceDetails({
      agentCharacters: { Newton: "vex", Ada: "sprout" },
    }).agentCharacters;
    const agents = [
      { id: "agent-newton", name: "Newton" },
      { id: "agent-ada-1", name: "Ada" },
      { id: "agent-ada-2", name: "Ada" },
    ];

    expect(migrateLegacyAgentCharacters(legacy, agents)).toEqual({
      byId: { "agent-newton": "vex" },
      legacyByName: { ada: "sprout" },
    });
  });

  test("keeps character identity stable across duplicate names and renames", () => {
    const assignments = {
      byId: { "agent-one": "vex", "agent-two": "sprout" },
      legacyByName: { newton: "brik" },
    };
    const duplicateNames = [
      { id: "agent-one", name: "Newton" },
      { id: "agent-two", name: "Newton" },
    ];

    expect(resolveAgentCharacterAssignment(
      assignments,
      { id: "agent-one", name: "Newton" },
      duplicateNames,
    )).toBe("vex");
    expect(resolveAgentCharacterAssignment(
      assignments,
      { id: "agent-two", name: "Newton" },
      duplicateNames,
    )).toBe("sprout");
    expect(resolveAgentCharacterAssignment(
      assignments,
      { id: "agent-one", name: "Renamed Newton" },
      [{ id: "agent-one", name: "Renamed Newton" }],
    )).toBe("vex");
    expect(resolveAgentCharacterAssignment(
      { byId: {}, legacyByName: { newton: "brik" } },
      { name: "Newton" },
      duplicateNames,
    )).toBeUndefined();
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

  test("persists agent character unassignment instead of resurrecting deleted keys", () => {
    const store = new Map<string, string>();
    const previousWindow = globalThis.window;
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
      location: new URL("http://127.0.0.1:43120/"),
    };

    // Test-only stub of a well-known DOM global; the shape is fully specified here.
    const windowStub = fakeWindow as unknown as Window & typeof globalThis;
    globalThis.window = windowStub;

    try {
      // hasAppearanceUrlOverride() reads location.search; an empty URL means no override.
      const base = normalizeScoutAppearanceDetails({ shell: "scout" });
      writeScoutAppearanceDetails({
        ...base,
        agentCharacters: {
          byId: { "agent-codex": "vex", "agent-sprout": "sprout" },
          legacyByName: {},
        },
      });
      expect(JSON.parse(store.get(SCOUT_THEME_STORAGE_KEY)!).agentCharacters).toEqual({
        byId: { "agent-codex": "vex", "agent-sprout": "sprout" },
        legacyByName: {},
      });

      // Unassign agent-codex: the next write omits the durable id entirely.
      writeScoutAppearanceDetails({
        ...base,
        agentCharacters: {
          byId: { "agent-sprout": "sprout" },
          legacyByName: {},
        },
      });
      expect(JSON.parse(store.get(SCOUT_THEME_STORAGE_KEY)!).agentCharacters).toEqual({
        byId: { "agent-sprout": "sprout" },
        legacyByName: {},
      });
    } finally {
      globalThis.window = previousWindow;
    }
  });
});
