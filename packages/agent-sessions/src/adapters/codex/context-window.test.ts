import { describe, expect, test } from "bun:test";

import {
  CODEX_GPT5_CONTEXT_WINDOW_TOKENS,
  codexContextWindowTokens,
  isGpt5Family,
} from "./context-window.js";

describe("codex context-window", () => {
  test("the GPT-5.x usable window is the real logged value (258,400)", () => {
    // Verified empirically across every observed Codex rollout.
    expect(CODEX_GPT5_CONTEXT_WINDOW_TOKENS).toBe(258_400);
  });

  test("GPT-5.x Codex models resolve to the current usable window", () => {
    for (const model of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5",
    ]) {
      expect(codexContextWindowTokens(model)).toBe(258_400);
    }
  });

  test("an unknown/absent Codex model still gets the current usable window", () => {
    expect(codexContextWindowTokens(undefined)).toBe(258_400);
    expect(codexContextWindowTokens("o4-mini")).toBe(258_400);
  });

  test("isGpt5Family recognizes the family (and tolerates casing/underscores)", () => {
    expect(isGpt5Family("gpt-5")).toBe(true);
    expect(isGpt5Family("gpt-5.6-sol")).toBe(true);
    expect(isGpt5Family("gpt-5.5")).toBe(true);
    expect(isGpt5Family("gpt-5.3-codex")).toBe(true);
    expect(isGpt5Family("GPT_5.4")).toBe(true);
    expect(isGpt5Family("gpt-4.1")).toBe(false);
    expect(isGpt5Family("claude-opus-5")).toBe(false);
    expect(isGpt5Family(null)).toBe(false);
  });
});
