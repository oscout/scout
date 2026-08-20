import { describe, expect, test } from "bun:test";
import {
  existingHandleSet,
  normalizeAgentHandle,
  routingPreview,
  suggestHandles,
  validateHandle,
} from "./new-agent-model.ts";

describe("normalizeAgentHandle", () => {
  test("slugs handles and strips @", () => {
    expect(normalizeAgentHandle("@Scope Reviewer")).toBe("scope-reviewer");
    expect(normalizeAgentHandle("  Foo_Bar.1  ")).toBe("foo_bar.1");
  });
  test("returns undefined when nothing survives", () => {
    expect(normalizeAgentHandle("@@@")).toBeUndefined();
    expect(normalizeAgentHandle("   ")).toBeUndefined();
  });
});

describe("validateHandle", () => {
  const existing = existingHandleSet(["@scope-claude", "Scope Codex", null]);

  test("empty means Scout auto-allocates a handle", () => {
    expect(validateHandle("", existing, "one_time")).toMatchObject({
      status: "auto",
      tone: "ok",
      normalized: undefined,
    });
    expect(validateHandle("", existing, "sticky")).toMatchObject({
      status: "auto",
      tone: "ok",
    });
  });

  test("flags input that slugs to nothing as invalid", () => {
    expect(validateHandle("@@@", existing, "sticky")).toMatchObject({
      status: "invalid",
      tone: "warn",
    });
  });

  test("detects conflicts against normalized existing handles", () => {
    const result = validateHandle("Scope Codex", existing, "sticky");
    expect(result.status).toBe("conflict");
    expect(result.normalized).toBe("scope-codex");
    expect(result.tone).toBe("warn");
  });

  test("accepts a fresh handle and echoes the rewrite", () => {
    const result = validateHandle("Scope Worker", existing, "sticky");
    expect(result.status).toBe("ok");
    expect(result.normalized).toBe("scope-worker");
    expect(result.rewritten).toBe(true);
  });
});

describe("suggestHandles", () => {
  test("offers project-first, conflict-filtered options", () => {
    const existing = existingHandleSet(["scope"]);
    const suggestions = suggestHandles("scope", "claude", existing, 3);
    expect(suggestions).not.toContain("scope");
    expect(suggestions[0]).toBe("scope-claude");
    expect(suggestions.length).toBe(3);
  });

  test("maps the pi harness to a grok tag", () => {
    const suggestions = suggestHandles("scope", "pi", new Set());
    expect(suggestions).toContain("scope-grok");
  });
});

describe("routingPreview", () => {
  test("handle yields a reusable, addressable session", () => {
    const preview = routingPreview({
      handle: "scope-claude",
      persistence: "sticky",
      harness: "claude",
      projectRootLabel: "~/dev/scope",
    });
    expect(preview.disposable).toBe(false);
    expect(preview.card).toBe("@scope-claude");
    expect(preview.cli).toBe('scout ask @scope-claude "…"');
  });

  test("blank handle previews automatic handle allocation", () => {
    const preview = routingPreview({
      handle: undefined,
      persistence: "sticky",
      harness: "claude",
      projectRootLabel: "~/dev/scope",
    });
    expect(preview.disposable).toBe(false);
    expect(preview.card).toBe("@auto");
    expect(preview.resolves).toMatch(/assigns/i);
  });

  test("one-off is disposable and not addressable later", () => {
    const preview = routingPreview({
      handle: undefined,
      persistence: "one_time",
      harness: "pi",
      projectRootLabel: "~/dev/scope",
    });
    expect(preview.disposable).toBe(true);
    expect(preview.card).toBeNull();
    expect(preview.resolves).toMatch(/disposable/i);
    expect(preview.cli).toBe('scout ask --project ~/dev/scope --harness pi "…"');
  });
});
