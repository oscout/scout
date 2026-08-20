import { describe, expect, test } from "bun:test";

import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  claudeContextWindowTokens,
  isClaudeModel,
} from "./context-window.js";

describe("claude context-window (catalog-backed, per version)", () => {
  test("resolves the window PER VERSION — the whole point of the catalog", () => {
    // newer = 1M, older = 200k — a flat "opus → 1M" rule would get one of these wrong
    expect(claudeContextWindowTokens("claude-opus-5")).toBe(1_000_000);
    expect(claudeContextWindowTokens("claude-opus-4-8")).toBe(1_000_000);
    expect(claudeContextWindowTokens("claude-sonnet-4-6")).toBe(1_000_000);
    expect(claudeContextWindowTokens("claude-opus-4-5")).toBe(200_000);
    expect(claudeContextWindowTokens("claude-sonnet-4-5")).toBe(200_000);
  });

  test("tolerates a provider prefix (pi-style)", () => {
    expect(claudeContextWindowTokens("anthropic/claude-opus-5")).toBe(1_000_000);
  });

  test("an unknown Claude model falls back to the conservative default", () => {
    expect(CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(200_000);
    expect(claudeContextWindowTokens("claude-opus-test")).toBe(200_000);
    expect(claudeContextWindowTokens("sonnet")).toBe(200_000);
    expect(claudeContextWindowTokens(undefined)).toBe(200_000);
  });

  test("a guest model (Grok) riding the claude-code log resolves via the catalog", () => {
    expect(claudeContextWindowTokens("grok-4.3")).toBe(1_000_000); // catalog
    expect(claudeContextWindowTokens("grok-4")).toBe(256_000); // override
  });

  test("isClaudeModel recognizes the family (and tolerates casing/underscores)", () => {
    expect(isClaudeModel("claude-opus-5")).toBe(true);
    expect(isClaudeModel("sonnet")).toBe(true);
    expect(isClaudeModel("HAIKU")).toBe(true);
    expect(isClaudeModel("gpt-5.5")).toBe(false);
    expect(isClaudeModel(null)).toBe(false);
  });
});
