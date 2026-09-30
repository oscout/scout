import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyUserConfigField,
  clearUserConfigField,
  findUserConfigField,
  formatUserConfigFieldGet,
  listUserConfigFieldIds,
  parseUserConfigFieldValue,
} from "./user-config-fields.js";

const priorHome = process.env.OPENSCOUT_HOME;
let tempHome = "";

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = "";
  }
  if (priorHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = priorHome;
  }
  // No saveUserConfig({}) here: with the real OPENSCOUT_HOME restored it
  // would blank the operator's real ~/.openscout/user.json (it did — that is
  // how onboarding forgot the operator's name). rmSync above already removed
  // the temp config.
});

function useTempHome(): void {
  tempHome = join(tmpdir(), `scout-user-config-${Date.now()}`);
  mkdirSync(tempHome, { recursive: true });
  process.env.OPENSCOUT_HOME = tempHome;
}

describe("user config field registry", () => {
  test("lists stable ids for scout config set/get", () => {
    const ids = listUserConfigFieldIds();
    expect(ids).toContain("name");
    expect(ids).toContain("handle");
    expect(ids).toContain("agent-names");
    expect(ids).toContain("agent-names-mode");
  });

  test("finds fields by id", () => {
    expect(findUserConfigField("working-hours")?.key).toBe("workingHours");
    expect(findUserConfigField("agent-names")?.kind).toBe("string-list");
  });

  test("parses and applies string and enum values", () => {
    useTempHome();
    const nameField = findUserConfigField("name")!;
    const modeField = findUserConfigField("agent-names-mode")!;

    expect(parseUserConfigFieldValue(nameField, ["Ada", "Lovelace"])).toBe("Ada Lovelace");
    expect(parseUserConfigFieldValue(modeField, ["extend"])).toBe("extend");

    const config = {};
    applyUserConfigField(config, nameField, "Ada");
    applyUserConfigField(config, modeField, "extend");
    expect(config.name).toBe("Ada");
    expect(config.provisionalAgentNamesMode).toBe("extend");
  });

  test("parses comma-separated agent name pools", () => {
    const field = findUserConfigField("agent-names")!;
    expect(parseUserConfigFieldValue(field, ["ada, grace, @linus"])).toEqual(["ada", "grace", "linus"]);
  });

  test("clears values when scout config set is called without a value", () => {
    useTempHome();
    const field = findUserConfigField("agent-names")!;
    const config = { provisionalAgentNames: ["ada"] };
    clearUserConfigField(config, field);
    expect(config.provisionalAgentNames).toBeUndefined();
    expect(formatUserConfigFieldGet(field, config)).toBe("");
  });

  test("rejects invalid enum values", () => {
    const field = findUserConfigField("tone")!;
    expect(() => parseUserConfigFieldValue(field, ["sarcastic"])).toThrow(/expected one of/i);
  });
});

describe("runtime list fields", () => {
  test("registers runtime-shortlist and runtime-presets", () => {
    expect(findUserConfigField("runtime-shortlist")?.key).toBe("runtimeShortlist");
    expect(findUserConfigField("runtime-presets")?.key).toBe("runtimePresets");
  });

  test("parses, applies, and reads back shortlist specs", () => {
    const field = findUserConfigField("runtime-shortlist")!;
    const specs = parseUserConfigFieldValue(field, ["claude/opus-5, codex"]);
    expect(specs).toEqual(["claude/opus-5", "codex"]);

    const config = {};
    applyUserConfigField(config, field, specs);
    expect(config.runtimeShortlist).toEqual(["claude/opus-5", "codex"]);
    expect(formatUserConfigFieldGet(field, config)).toBe("claude/opus-5, codex");

    clearUserConfigField(config, field);
    expect(config.runtimeShortlist).toBeUndefined();
  });

  test("does not pass runtime specs through agent-name slugification", () => {
    const field = findUserConfigField("runtime-shortlist")!;
    const config = {};
    applyUserConfigField(
      config,
      field,
      parseUserConfigFieldValue(field, ["claude/Opus-5.x"]),
    );
    expect(config.runtimeShortlist).toEqual(["claude/Opus-5.x"]);
  });

  test("rejects invalid shortlist specs and effort suffixes", () => {
    const field = findUserConfigField("runtime-shortlist")!;
    expect(() => parseUserConfigFieldValue(field, ["notharness/x"])).toThrow(/invalid runtime spec/i);
    expect(() => parseUserConfigFieldValue(field, ["claude/opus/high"])).toThrow(/not an effort/i);
  });

  test("parses preset grammar with labels and slugified ids", () => {
    const field = findUserConfigField("runtime-presets")!;
    const presets = parseUserConfigFieldValue(
      field,
      ["Fusion Thing:Fusion=claude/fable-5.1/medium, spark=codex/gpt-6-astra/high"],
    );
    expect(presets).toEqual([
      { id: "fusion-thing", label: "Fusion", runtime: "claude/fable-5.1/medium" },
      { id: "spark", runtime: "codex/gpt-6-astra/high" },
    ]);

    const config = {};
    applyUserConfigField(config, field, presets);
    expect(formatUserConfigFieldGet(field, config)).toBe(
      "fusion-thing:Fusion=claude/fable-5.1/medium, spark=codex/gpt-6-astra/high",
    );
  });

  test("rejects preset ids that collide with reserved grammar words", () => {
    const field = findUserConfigField("runtime-presets")!;
    expect(() => parseUserConfigFieldValue(field, ["fable=claude/opus"])).toThrow(/reserved/i);
    expect(() => parseUserConfigFieldValue(field, ["claude=claude/opus"])).toThrow(/harness/i);
    expect(() => parseUserConfigFieldValue(field, ["high=claude/opus"])).toThrow(/effort/i);
    expect(() => parseUserConfigFieldValue(field, ["noparen"])).toThrow(/id\[:Label\]=/);
    expect(() => parseUserConfigFieldValue(field, ["x=notharness/y"])).toThrow(/invalid runtime spec/i);
  });

  test("clearing runtime fields removes the keys", () => {
    const presets = findUserConfigField("runtime-presets")!;
    const shortlist = findUserConfigField("runtime-shortlist")!;
    const config = {
      runtimePresets: [{ id: "a", runtime: "claude/opus" }],
      runtimeShortlist: ["codex/x"],
    };
    clearUserConfigField(config, presets);
    clearUserConfigField(config, shortlist);
    expect(config.runtimePresets).toBeUndefined();
    expect(config.runtimeShortlist).toBeUndefined();
  });
});