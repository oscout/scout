import { afterEach, describe, expect, test } from "bun:test";
import { applyEmbedDocumentTitle } from "./embed-document-title.ts";

type TitleDocument = { title: string };

function installTitleDocument(initialTitle: string): TitleDocument {
  const stub: TitleDocument = { title: initialTitle };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: stub,
  });
  return stub;
}

describe("useEmbedHeadline", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
  });

  test("sets document.title when enabled with a non-empty title", () => {
    const doc = installTitleDocument("Initial");
    const cleanup = applyEmbedDocumentTitle("Projects", true);
    expect(doc.title).toBe("Projects");
    cleanup?.();
  });

  test("restores the previous document.title on cleanup", () => {
    const doc = installTitleDocument("Initial");
    const cleanup = applyEmbedDocumentTitle("Lanes", true);
    expect(doc.title).toBe("Lanes");
    cleanup?.();
    expect(doc.title).toBe("Initial");
  });

  test("leaves document.title untouched when disabled", () => {
    const doc = installTitleDocument("Initial");
    const cleanup = applyEmbedDocumentTitle("Dispatch", false);
    expect(cleanup).toBeUndefined();
    expect(doc.title).toBe("Initial");
  });
});
