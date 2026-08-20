import { describe, expect, test } from "bun:test";

import {
  MAX_CONTEXT_SELECTION_CHARS,
  boundedSelection,
  buildComposerContext,
  formatComposerContextBody,
} from "./composer-context.ts";

describe("buildComposerContext", () => {
  test("drops empty facts rather than emitting labelled blanks", () => {
    const items = buildComposerContext({ pageTitle: "Agents", pageUrl: "" });
    expect(items).toEqual([{ label: "Page", value: "Agents" }]);
  });

  test("omits selection unless one is explicitly supplied", () => {
    expect(buildComposerContext({ pageTitle: "Agents" }).some((i) => i.label === "Selection"))
      .toBe(false);
    expect(buildComposerContext({ pageTitle: "Agents", selection: "  " })
      .some((i) => i.label === "Selection")).toBe(false);
    expect(buildComposerContext({ pageTitle: "Agents", selection: "boom" })
      .some((i) => i.label === "Selection")).toBe(true);
  });

  test("bounds the selection so what the composer shows is what goes out", () => {
    const long = "x".repeat(MAX_CONTEXT_SELECTION_CHARS + 500);
    const [selection] = buildComposerContext({ selection: long })
      .filter((i) => i.label === "Selection");
    expect(selection.value.length).toBe(MAX_CONTEXT_SELECTION_CHARS);
    expect(boundedSelection(`   ${long}   `).length).toBe(MAX_CONTEXT_SELECTION_CHARS);
  });

  test("numbers notes from one", () => {
    const items = buildComposerContext({ notes: ["first", "second"] });
    expect(items.map((i) => i.label)).toEqual(["Note 1", "Note 2"]);
  });
});

describe("formatComposerContextBody", () => {
  test("states page and URL inline and block-quotes everything else", () => {
    const body = formatComposerContextBody("Fix this", [
      { label: "Page", value: "Agents" },
      { label: "URL", value: "https://scout.test/agents" },
      { label: "Selection", value: "line one\nline two" },
    ]);
    expect(body).toBe(
      "Page: Agents\n\nURL: https://scout.test/agents\n\nSelection:\n> line one\n> line two\n\nFix this",
    );
  });

  test("puts the operator's message last, after the setting is established", () => {
    const body = formatComposerContextBody("do the thing", [
      { label: "Page", value: "Agents" },
    ]);
    expect(body.endsWith("do the thing")).toBe(true);
  });

  test("returns the bare message when there is no context", () => {
    expect(formatComposerContextBody("  just this  ", [])).toBe("just this");
  });

  test("returns bare context when there is no message", () => {
    expect(formatComposerContextBody("   ", [{ label: "Page", value: "Agents" }]))
      .toBe("Page: Agents");
  });

  test("emits nothing at all when both sides are empty", () => {
    expect(formatComposerContextBody("", [{ label: "URL", value: "   " }])).toBe("");
  });
});
