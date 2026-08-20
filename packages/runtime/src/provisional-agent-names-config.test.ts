import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PROVISIONAL_AGENT_NAMES } from "@openscout/protocol";

import {
  defaultProvisionalAgentNamesPath,
  loadProvisionalAgentNamePool,
  mergeProvisionalAgentNamePool,
  resolveProvisionalAgentNamePool,
  seedProvisionalAgentNamesInUserConfig,
  writeProvisionalAgentNamesFile,
} from "./provisional-agent-names-config.js";
import { saveUserConfig } from "./user-config.js";

const priorHome = process.env.OPENSCOUT_HOME;
const priorEnvFile = process.env.OPENSCOUT_PROVISIONAL_AGENT_NAMES_FILE;
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
  if (priorEnvFile === undefined) {
    delete process.env.OPENSCOUT_PROVISIONAL_AGENT_NAMES_FILE;
  } else {
    process.env.OPENSCOUT_PROVISIONAL_AGENT_NAMES_FILE = priorEnvFile;
  }
  saveUserConfig({});
});

function useTempHome(): string {
  tempHome = join(tmpdir(), `scout-names-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempHome, { recursive: true });
  process.env.OPENSCOUT_HOME = tempHome;
  return tempHome;
}

describe("provisional agent name pool config", () => {
  test("uses the built-in pool when no settings are present", () => {
    useTempHome();
    expect(loadProvisionalAgentNamePool()).toEqual(PROVISIONAL_AGENT_NAMES);
  });

  test("loads inline Scout settings in replace mode", () => {
    useTempHome();
    saveUserConfig({
      provisionalAgentNames: ["ada", "grace"],
      provisionalAgentNamesMode: "replace",
    });
    const resolved = resolveProvisionalAgentNamePool();
    expect(resolved.source).toBe("user-settings-replace");
    expect(loadProvisionalAgentNamePool()).toEqual(["ada", "grace"]);
  });

  test("extends inline Scout settings with built-in defaults", () => {
    useTempHome();
    saveUserConfig({
      provisionalAgentNames: ["ada", "archimedes"],
      provisionalAgentNamesMode: "extend",
    });
    const resolved = resolveProvisionalAgentNamePool();
    expect(resolved.source).toBe("user-settings-extend");
    expect(resolved.names[0]).toBe("ada");
    expect(resolved.names[1]).toBe("archimedes");
    expect(resolved.names.filter((name) => name === "archimedes")).toHaveLength(1);
    expect(resolved.names.length).toBe(PROVISIONAL_AGENT_NAMES.length + 1);
  });

  test("prefers inline settings over file drop-ins", () => {
    const home = useTempHome();
    writeFileSync(defaultProvisionalAgentNamesPath(), JSON.stringify(["file-only"]), "utf8");
    saveUserConfig({ provisionalAgentNames: ["settings-win"] });
    expect(loadProvisionalAgentNamePool()).toEqual(["settings-win"]);
    const teamPath = join(home, "team-pool.json");
    writeFileSync(teamPath, JSON.stringify({ names: ["file-path"] }), "utf8");
    saveUserConfig({
      provisionalAgentNames: ["settings-win"],
      provisionalAgentNamesFile: teamPath,
    });
    expect(loadProvisionalAgentNamePool()).toEqual(["settings-win"]);
  });

  test("loads a drop-in home JSON pool when settings are empty", () => {
    useTempHome();
    writeFileSync(
      defaultProvisionalAgentNamesPath(),
      JSON.stringify({ names: ["ada", "grace"] }),
      "utf8",
    );
    expect(loadProvisionalAgentNamePool()).toEqual(["ada", "grace"]);
  });

  test("mergeProvisionalAgentNamePool dedupes extended defaults", () => {
    expect(mergeProvisionalAgentNamePool(["curie", "ada"], "extend")[0]).toBe("curie");
    expect(mergeProvisionalAgentNamePool(["curie", "ada"], "extend")).toContain("archimedes");
    expect(mergeProvisionalAgentNamePool(["curie"], "extend").filter((name) => name === "curie")).toHaveLength(1);
  });

  test("seedProvisionalAgentNamesInUserConfig writes settings-friendly values", () => {
    useTempHome();
    const config = seedProvisionalAgentNamesInUserConfig({ empty: true, mode: "extend" });
    saveUserConfig(config);
    expect(resolveProvisionalAgentNamePool().source).toBe("user-settings-extend");
    expect(loadProvisionalAgentNamePool()).toEqual(["ada", "grace", "linus", ...PROVISIONAL_AGENT_NAMES]);
  });

  test("writeProvisionalAgentNamesFile still supports advanced JSON drop-ins", () => {
    useTempHome();
    const path = writeProvisionalAgentNamesFile();
    expect(existsSync(path)).toBe(true);
    expect(resolveProvisionalAgentNamePool().source).toBe("home-json");
    expect(resolveProvisionalAgentNamePool().names.length).toBeGreaterThan(50);
  });
});