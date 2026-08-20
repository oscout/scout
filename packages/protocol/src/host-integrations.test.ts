import { describe, expect, test } from "bun:test";

import { AGENT_HARNESSES } from "./actors.js";
import {
  scoutHostIntegrationById,
  scoutHostIntegrationHasRole,
} from "./host-integrations.js";

describe("Scout host integration catalog", () => {
  test("keeps Hermes and Herdr first-class without making them harnesses", () => {
    const hermes = scoutHostIntegrationById("hermes");
    const herdr = scoutHostIntegrationById("herdr");

    expect(hermes).toBeTruthy();
    expect(herdr).toBeTruthy();
    expect(hermes?.harness).toBeUndefined();
    expect(herdr?.harness).toBeUndefined();
    expect(AGENT_HARNESSES).not.toContain("hermes");
    expect(AGENT_HARNESSES).not.toContain("herdr");
    expect(hermes && scoutHostIntegrationHasRole(hermes, "mcp_host")).toBe(
      true,
    );
    expect(herdr && scoutHostIntegrationHasRole(herdr, "terminal_host")).toBe(
      true,
    );
    expect(
      herdr && scoutHostIntegrationHasRole(herdr, "agent_state_surface"),
    ).toBe(true);
  });
});
