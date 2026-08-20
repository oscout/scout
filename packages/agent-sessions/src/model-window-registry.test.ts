import { afterEach, describe, expect, test } from "bun:test";

import {
  clearObservedContextWindows,
  observedContextWindowTokens,
  recordObservedContextWindow,
} from "./model-window-registry.js";

afterEach(clearObservedContextWindows);

describe("model-window-registry", () => {
  test("records and reads a window per model", () => {
    recordObservedContextWindow("gpt-5.5", 258_400);
    expect(observedContextWindowTokens("gpt-5.5")).toBe(258_400);
  });

  test("is learn-once: the first non-zero value per model wins", () => {
    recordObservedContextWindow("gpt-5.5", 258_400);
    recordObservedContextWindow("gpt-5.5", 999_999);
    expect(observedContextWindowTokens("gpt-5.5")).toBe(258_400);
  });

  test("ignores zero / invalid / missing windows", () => {
    recordObservedContextWindow("gpt-5.5", 0);
    recordObservedContextWindow("gpt-5.5", -1);
    recordObservedContextWindow("gpt-5.5", null);
    recordObservedContextWindow("gpt-5.5", undefined);
    recordObservedContextWindow("gpt-5.5", Number.NaN);
    expect(observedContextWindowTokens("gpt-5.5")).toBeUndefined();
  });

  test("ignores an empty model key", () => {
    recordObservedContextWindow("", 258_400);
    recordObservedContextWindow(null, 258_400);
    expect(observedContextWindowTokens("")).toBeUndefined();
  });

  test("normalizes casing and underscores", () => {
    recordObservedContextWindow("GPT_5.5", 258_400);
    expect(observedContextWindowTokens("gpt-5.5")).toBe(258_400);
    expect(observedContextWindowTokens("  GPT-5.5 ")).toBe(258_400);
  });

  test("unknown model resolves to undefined", () => {
    expect(observedContextWindowTokens("never-seen")).toBeUndefined();
  });
});
