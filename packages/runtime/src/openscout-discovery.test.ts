import { describe, expect, test } from "bun:test";
import {
  OPENSCOUT_AGENT_DISCOVERY,
  PROJECT_AGENT_INSTRUCTION_CANDIDATES,
} from "./openscout-discovery.ts";

describe("OPENSCOUT_AGENT_DISCOVERY", () => {
  test("points at well-known and root agent entry paths", () => {
    expect(OPENSCOUT_AGENT_DISCOVERY.agentInstructions).toBe(
      "https://openscout.app/.well-known/agent.md",
    );
    expect(OPENSCOUT_AGENT_DISCOVERY.agentInstructionsAlt).toContain(
      "https://openscout.app/.well-known/agents.md",
    );
    expect(OPENSCOUT_AGENT_DISCOVERY.manifest).toContain("/.well-known/scout.json");
  });

  test("lists common project instruction filenames", () => {
    expect(PROJECT_AGENT_INSTRUCTION_CANDIDATES[0]).toBe("AGENTS.md");
  });
});
