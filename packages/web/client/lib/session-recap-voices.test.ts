import { describe, expect, test } from "bun:test";

import type { ScoutSpeechCatalog } from "./scout-voice.ts";
import { assignRecapVoices } from "./session-recap-voices.ts";

const catalog: ScoutSpeechCatalog = {
  defaultModelId: "system",
  models: [{ id: "system", name: "System", provider: "system", available: true }],
  voices: [
    { id: "v1", name: "One", provider: "system", modelId: "system", available: true, isDefault: true },
    { id: "v2", name: "Two", provider: "system", modelId: "system", available: true, isDefault: false },
    { id: "v3", name: "Three", provider: "system", modelId: "system", available: true, isDefault: false },
  ],
  source: "fallback",
};

describe("assignRecapVoices", () => {
  test("keeps assignments stable across reorder and remount", () => {
    const first = assignRecapVoices(["a", "b"], catalog, "system");
    const remount = assignRecapVoices(["b", "a"], catalog, "system", first.assignments);
    expect(remount.assignments.a).toEqual(first.assignments.a);
    expect(remount.assignments.b).toEqual(first.assignments.b);
  });

  test("missing assigned voice falls back explicitly", () => {
    const plan = assignRecapVoices(["a"], catalog, "system", {
      a: { modelId: "system", voiceId: "gone" },
    });
    expect(plan.assignments.a?.voiceId).not.toBe("gone");
    expect(plan.notices.some((notice) => notice.includes("unavailable"))).toBe(true);
  });
});
