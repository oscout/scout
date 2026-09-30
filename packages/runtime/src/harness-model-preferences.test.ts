import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readHarnessModelPreferences } from "./harness-model-preferences.js";

const HOME = "/harness-prefs-home";
const ENV = {} as NodeJS.ProcessEnv;

function reader(files: Record<string, string>) {
  return async (path: string) => files[path] ?? null;
}

const CODEX_CONFIG = join(HOME, ".codex", "config.toml");
const CLAUDE_CONFIG = join(HOME, ".claude", "settings.json");
const OPENCODE_STATE = join(HOME, ".local", "state", "opencode", "model.json");
const KIMI_CONFIG = join(HOME, ".kimi-code", "config.toml");

describe("readHarnessModelPreferences", () => {
  test("missing files produce an empty map without throwing", async () => {
    const prefs = await readHarnessModelPreferences({
      env: ENV,
      homeDir: HOME,
      readFile: reader({}),
    });
    expect(prefs).toEqual({});
  });

  test("reads codex defaults and profile tables", async () => {
    const prefs = await readHarnessModelPreferences({
      env: ENV,
      homeDir: HOME,
      readFile: reader({
        [CODEX_CONFIG]: [
          'model = "gpt-6-astra"',
          'model_reasoning_effort = "low"',
          "",
          "[profiles.deep]",
          'model = "gpt-6-astra-pro"',
          'model_reasoning_effort = "high"',
          "",
          "[profiles.fast]",
          'model = "gpt-6-mini"',
        ].join("\n"),
      }),
    });
    expect(prefs.codex).toEqual({
      defaultModel: "gpt-6-astra",
      defaultEffort: "low",
      favorites: [],
      recent: [],
      profiles: [
        { id: "deep", label: "deep", model: "gpt-6-astra-pro", effort: "high" },
        { id: "fast", label: "fast", model: "gpt-6-mini" },
      ],
      source: CODEX_CONFIG,
    });
  });

  test("reads claude model and preserves aliases", async () => {
    const prefs = await readHarnessModelPreferences({
      env: ENV,
      homeDir: HOME,
      readFile: reader({ [CLAUDE_CONFIG]: JSON.stringify({ model: "opus" }) }),
    });
    expect(prefs.claude?.defaultModel).toBe("opus");
  });

  test("reads opencode favorites then recents with both id forms", async () => {
    const prefs = await readHarnessModelPreferences({
      env: ENV,
      homeDir: HOME,
      readFile: reader({
        [OPENCODE_STATE]: JSON.stringify({
          favorite: [{ providerID: "opencode-go", modelID: "glm-5.2" }],
          recent: [
            { providerID: "xai", modelID: "grok-4.5" },
            { modelID: "unqualified" },
          ],
        }),
      }),
    });
    expect(prefs.opencode?.favorites).toEqual(["opencode-go/glm-5.2", "glm-5.2"]);
    expect(prefs.opencode?.recent).toEqual(["xai/grok-4.5", "grok-4.5", "unqualified"]);
  });

  test("reads kimi default_model and configured model keys", async () => {
    const prefs = await readHarnessModelPreferences({
      env: ENV,
      homeDir: HOME,
      readFile: reader({
        [KIMI_CONFIG]: [
          'default_model = "kimi-code/k3"',
          "",
          '[models."kimi-code/kimi-for-coding"]',
          'kind = "a"',
          '[models."kimi-code/k3"]',
          'kind = "b"',
        ].join("\n"),
      }),
    });
    expect(prefs.kimi?.defaultModel).toBe("kimi-code/k3");
    expect(prefs.kimi?.favorites).toEqual(["kimi-code/kimi-for-coding", "kimi-code/k3"]);
  });

  test("malformed files are empty results, not errors", async () => {
    const prefs = await readHarnessModelPreferences({
      env: ENV,
      homeDir: HOME,
      readFile: reader({
        [CODEX_CONFIG]: "this is = = not toml [[[",
        [CLAUDE_CONFIG]: "{not json",
        [KIMI_CONFIG]: "[[[",
      }),
    });
    expect(prefs.codex).toBeUndefined();
    expect(prefs.claude).toBeUndefined();
    expect(prefs.kimi).toBeUndefined();
  });

  test("honors env overrides for config locations", async () => {
    const codexHome = "/custom/codex";
    const claudeHome = "/custom/claude";
    const stateHome = "/custom/state";
    const prefs = await readHarnessModelPreferences({
      env: {
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        XDG_STATE_HOME: stateHome,
      } as NodeJS.ProcessEnv,
      homeDir: HOME,
      readFile: reader({
        [join(codexHome, "config.toml")]: 'model = "gpt-x"',
        [join(claudeHome, "settings.json")]: JSON.stringify({ model: "sonnet" }),
        [join(stateHome, "opencode", "model.json")]: JSON.stringify({
          recent: [{ providerID: "opencode", modelID: "kimi-k2.5-free" }],
        }),
      }),
    });
    expect(prefs.codex?.defaultModel).toBe("gpt-x");
    expect(prefs.claude?.defaultModel).toBe("sonnet");
    expect(prefs.opencode?.recent).toEqual(["opencode/kimi-k2.5-free", "kimi-k2.5-free"]);
  });
});
