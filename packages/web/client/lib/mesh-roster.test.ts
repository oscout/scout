import { describe, expect, test } from "bun:test";

import type { Agent } from "./types.ts";
import {
  filterMeshRosterAgents,
  hasNamedRole,
  hasProjectBinding,
  isMeshRosterAgent,
  isSessionStyleAgent,
} from "./mesh-roster.ts";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    definitionId: id.split(".")[0] ?? id,
    name: id,
    state: "available",
    staleLocalRegistration: false,
    retiredFromFleet: false,
    agentClass: "general",
    ...overrides,
  } as Agent;
}

describe("mesh-roster", () => {
  test("recognises session-style agents even when they carry a project label", () => {
    const row = agent("session-mt0d9jke-lj1rsu.main.arts-mini", {
      name: "Session Mt0d9jke Lj1rsu",
      handle: "session-mt0d9jke-lj1rsu",
      definitionId: "session-mt0d9jke-lj1rsu",
      project: "openscout",
      selector: "@session-mt0d9jke-lj1rsu.main.node:arts-mini",
    });
    expect(isSessionStyleAgent(row)).toBe(true);
    expect(isMeshRosterAgent(row)).toBe(false);
  });

  test("keeps project crew and named roles", () => {
    const roster = filterMeshRosterAgents([
      agent("arc-author.arc-server", {
        name: "Arc Author",
        handle: "arc-author",
        definitionId: "arc-author",
        project: "Arc",
      }),
      agent("openscout-agent-2.main.arts-mini", {
        name: "Openscout Agent 2",
        handle: "openscout-agent-2",
        definitionId: "openscout-agent-2",
        project: "Openscout",
      }),
      agent("scoutbot", {
        name: "Scoutbot",
        handle: "scoutbot",
        definitionId: "scoutbot",
      }),
      agent("session-mt0d9jke-lj1rsu.main.arts-mini", {
        name: "Session Mt0d9jke Lj1rsu",
        handle: "session-mt0d9jke-lj1rsu",
        definitionId: "session-mt0d9jke-lj1rsu",
        project: "openscout",
      }),
      agent("codex-live", { agentClass: "organic" }),
    ]);
    expect(roster.map((row) => row.id)).toEqual([
      "arc-author.arc-server",
      "openscout-agent-2.main.arts-mini",
      "scoutbot",
    ]);
    expect(hasProjectBinding(agent("arc-author.arc-server", { project: "Arc" }))).toBe(true);
    expect(hasNamedRole(agent("scoutbot", { handle: "scoutbot", definitionId: "scoutbot" }))).toBe(true);
  });
});
