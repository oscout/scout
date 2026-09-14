import { expect, test } from "bun:test";
import { floorCharacterName } from "./floor-character-name.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
const lane = (name: string, harness = "codex") => ({ id: "session-12345678", agent: { name, harness, agentClass: "organic" } }) as AgentLane;
test("observed nickname survives organic session classification without suffix", () => {
  expect(floorCharacterName(lane("  Rowan  "))).toEqual({ name: "Rowan", label: "Rowan", named: true });
});
test("synthesized parent and subagent names keep a discriminator", () => {
  expect(floorCharacterName(lane("Codex 01a07ecc")).label).toBe("codex · 5678");
  expect(floorCharacterName(lane("Codex subagent 01a07ecc")).named).toBe(false);
});
test("missing or harness-only names never invent a nickname", () => {
  expect(floorCharacterName(lane("" )).named).toBe(false);
  expect(floorCharacterName(lane("Codex")).label).toBe("codex · 5678");
});
test("deliberate multiword names remain intact", () => {
  expect(floorCharacterName(lane("Build gardener")).label).toBe("Build gardener");
});
