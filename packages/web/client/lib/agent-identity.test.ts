import { describe, expect, test } from "bun:test";
import { HARNESS_HUE } from "./agent-identity.ts";

describe("HARNESS_HUE", () => {
  test("covers curated harness mappings", () => {
    expect(HARNESS_HUE.claude).toBe(262);
    expect(HARNESS_HUE.codex).toBe(135);
    expect(HARNESS_HUE.cursor).toBe(235);
    expect(HARNESS_HUE.native).toBe(250);
    expect(HARNESS_HUE.worker).toBe(195);
    expect(HARNESS_HUE.pi).toBe(176);
    expect(HARNESS_HUE.kimi).toBe(238);
    expect(HARNESS_HUE.grok).toBe(266);
    expect(HARNESS_HUE["grok-acp"]).toBe(266);
    expect(HARNESS_HUE.opencode).toBe(160);
    expect(HARNESS_HUE.oc).toBe(160);
  });

  test("harness dots stay distinct and the grok family shares one hue", () => {
    expect(HARNESS_HUE["grok-acp"]).toBe(HARNESS_HUE.grok);
    expect(HARNESS_HUE.oc).toBe(HARNESS_HUE.opencode);
    expect(HARNESS_HUE.kimi).not.toBe(HARNESS_HUE.grok);
    expect(HARNESS_HUE.kimi).not.toBe(HARNESS_HUE.claude);
    expect(HARNESS_HUE.grok).not.toBe(HARNESS_HUE.codex);
  });
});
