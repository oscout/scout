import { describe, expect, test } from "bun:test";

import { resolveStudioInjectionState } from "./studio-injection-state.ts";

describe("resolveStudioInjectionState", () => {
  test("stays disabled by default in dev", () => {
    expect(resolveStudioInjectionState({
      studyId: "agent-directory",
      href: "http://localhost:43120/agents",
      dev: true,
    })).toEqual({ enabled: false, mode: "after" });
  });

  test("enables an agent-directory injection from the live URL", () => {
    expect(resolveStudioInjectionState({
      studyId: "agent-directory",
      aliases: ["agents"],
      href: "http://localhost:43120/agents?studio=agents",
      dev: true,
    })).toEqual({ enabled: true, mode: "after" });
  });

  test("uses URL mode ahead of stored mode", () => {
    expect(resolveStudioInjectionState({
      studyId: "agent-directory",
      href: "http://localhost:43120/agents?studio=agent-directory&studioMode=before",
      storedMode: "after",
      dev: true,
    })).toEqual({ enabled: true, mode: "before" });
  });

  test("restores stored enablement and mode", () => {
    expect(resolveStudioInjectionState({
      studyId: "agent-directory",
      href: "http://localhost:43120/agents",
      storedEnabled: "1",
      storedMode: "before",
      dev: true,
    })).toEqual({ enabled: true, mode: "before" });
  });

  test("allows explicit local injection from the built app", () => {
    expect(resolveStudioInjectionState({
      studyId: "agent-directory",
      aliases: ["agents"],
      href: "http://localhost:43120/agents?studio=agents",
      dev: false,
    })).toEqual({ enabled: true, mode: "after" });
  });

  test("allows explicit IPv6 loopback injection from the built app", () => {
    expect(resolveStudioInjectionState({
      studyId: "agent-directory",
      href: "http://[::1]:43120/agents?studio=agent-directory",
      dev: false,
    })).toEqual({ enabled: true, mode: "after" });
  });

  test("keeps study-specific aliases out of the generic resolver", () => {
    expect(resolveStudioInjectionState({
      studyId: "other-study",
      href: "http://localhost:43120/agents?studio=agents",
      dev: true,
    })).toEqual({ enabled: false, mode: "after" });
  });

  test("does not keep agent-directory-specific params in the generic resolver", () => {
    expect(resolveStudioInjectionState({
      studyId: "other-study",
      href: "http://localhost:43120/agents?studioAgentDirectory=1",
      dev: true,
    })).toEqual({ enabled: false, mode: "after" });
  });

  test("never enables on non-local production hosts", () => {
    expect(resolveStudioInjectionState({
      studyId: "agent-directory",
      href: "https://openscout.example/agents?studio=agents",
      storedEnabled: "1",
      storedMode: "before",
      dev: false,
    })).toEqual({ enabled: false, mode: "after" });
  });
});
