import { describe, expect, test } from "bun:test";
import { isCodeFileName, isMarkdownFileName } from "./capture-attachments.ts";
import {
  dataTransferMayContainFiles,
  isRoutableMediaFile,
  isRoutableMediaType,
  readRoutableFiles,
  resolvedUploadMediaType,
} from "./media-blobs.ts";

function fakeTransfer(input: {
  files?: File[];
  items?: Array<{ kind: string; file?: File | null }>;
  types?: string[];
}): DataTransfer {
  const items = input.items ?? [];
  return {
    files: input.files ?? [],
    items: items.map((item) => ({
      kind: item.kind,
      getAsFile: () => item.file ?? null,
    })),
    types: input.types ?? [],
  } as unknown as DataTransfer;
}

describe("media blob routing", () => {
  test("accepts image, video, markdown, and code mime types", () => {
    expect(isRoutableMediaType("image/png")).toBe(true);
    expect(isRoutableMediaType("video/mp4")).toBe(true);
    expect(isRoutableMediaType("text/markdown")).toBe(true);
    expect(isRoutableMediaType("text/plain", "router.ts")).toBe(true);
    expect(isRoutableMediaType("text/plain", "notes.txt")).toBe(true);
    expect(isRoutableMediaType("text/plain")).toBe(false);
  });

  test("accepts routable files by type or capture extension", () => {
    expect(isRoutableMediaFile({ type: "image/jpeg", name: "shot.png" })).toBe(true);
    expect(isRoutableMediaFile({ type: "application/pdf", name: "brief.pdf" })).toBe(false);
    expect(isRoutableMediaFile({ type: "", name: "plan.md" })).toBe(true);
    expect(isRoutableMediaFile({ type: "", name: "src/router.ts" })).toBe(true);
    expect(isMarkdownFileName("docs/README.markdown")).toBe(true);
    expect(isCodeFileName("Dockerfile")).toBe(true);
  });

  test("resolves capture uploads to the right text mime", () => {
    expect(resolvedUploadMediaType({ type: "text/plain", name: "brief.md" })).toBe("text/markdown");
    expect(resolvedUploadMediaType({ type: "text/plain", name: "router.ts" })).toBe("text/typescript");
    expect(resolvedUploadMediaType({ type: "", name: "config.json" })).toBe("application/json");
    expect(resolvedUploadMediaType({ type: "image/png", name: "shot.png" })).toBe("image/png");
  });

  test("recognizes protected drag payloads before File objects are readable", () => {
    expect(dataTransferMayContainFiles(fakeTransfer({ types: ["Files"] }))).toBe(true);
    expect(dataTransferMayContainFiles(fakeTransfer({
      items: [{ kind: "file", file: null }],
    }))).toBe(true);
    expect(dataTransferMayContainFiles(fakeTransfer({ types: ["text/plain"] }))).toBe(false);
  });

  test("reads and filters files once the drop payload is available", () => {
    const image = new File(["image"], "shot.png", { type: "image/png" });
    const pdf = new File(["pdf"], "brief.pdf", { type: "application/pdf" });

    expect(readRoutableFiles(fakeTransfer({ files: [image, pdf], types: ["Files"] })))
      .toEqual([image]);
  });
});
