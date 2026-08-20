import { describe, expect, test } from "bun:test";
import { resolvePierreDiffTheme } from "./pierre-theme.ts";

describe("resolvePierreDiffTheme", () => {
  test("keeps explicit light themes", () => {
    expect(resolvePierreDiffTheme("pierre-light", "dark")).toBe("pierre-light");
    expect(resolvePierreDiffTheme("pierre-light-soft", "dark")).toBe("pierre-light-soft");
  });

  test("remaps pierre-dark when UI is light", () => {
    expect(resolvePierreDiffTheme("pierre-dark", "light")).toBe("pierre-light");
    expect(resolvePierreDiffTheme("", "light")).toBe("pierre-light");
    expect(resolvePierreDiffTheme(undefined, "light")).toBe("pierre-light");
  });

  test("remaps github-dark when UI is light", () => {
    expect(resolvePierreDiffTheme("github-dark", "light")).toBe("github-light");
  });

  test("keeps dark themes when UI is dark", () => {
    expect(resolvePierreDiffTheme("pierre-dark", "dark")).toBe("pierre-dark");
    expect(resolvePierreDiffTheme("github-dark", "dark")).toBe("github-dark");
    expect(resolvePierreDiffTheme(undefined, "dark")).toBe("pierre-dark");
  });
});
