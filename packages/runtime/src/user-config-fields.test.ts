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
import { saveUserConfig } from "./user-config.js";

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
  saveUserConfig({});
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