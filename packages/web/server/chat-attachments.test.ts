import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localPathFromBlobKey, resolveChatAttachment } from "./chat-attachments.ts";

import { putImageBlob, resetChatBlobStoreForTests } from "./image-blob-store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function makeRoot(): string {
  const root = join(tmpdir(), `openscout-chat-attach-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

describe("resolveChatAttachment", () => {
  test("uploaded URLs do not require a local blob key", () => {
    expect(localPathFromBlobKey(undefined)).toBeNull();
    const resolved = resolveChatAttachment(
      { id: "uploaded", mediaType: "image/png", url: "/api/blobs/uploaded" },
      { channelId: "chn-1", currentDirectory: "/tmp", allowLocalPaths: true },
    );
    expect(resolved).toEqual({ ok: true, attachment: {
      id: "uploaded", mediaType: "image/png", url: "/api/blobs/uploaded",
      fileName: undefined, blobKey: undefined,
    } });
  });

  test("keeps a trusted local path as a live file pointer", () => {
    const root = makeRoot();
    const file = join(root, "clip.mp4");
    writeFileSync(file, "not-really-video");
    const resolved = resolveChatAttachment(
      { localPath: file, fileName: "clip.mp4" },
      { channelId: "chn-1", currentDirectory: root, allowLocalPaths: true },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.attachment.mediaType).toBe("video/mp4");
    expect(localPathFromBlobKey(resolved.attachment.blobKey)).toEndWith("/clip.mp4");
    expect(resolved.attachment.url).toBe("/api/channels/chn-1/attachments/" + resolved.attachment.id);
  });

  test("requires explicit operator authority for every local-pointer spelling", () => {
    for (const attachment of [
      { localPath: "/tmp/file" },
      { metadata: { localPath: "/tmp/file" } },
      { blobKey: "local:/tmp/file" },
      { blobKey: "  local:/tmp/file  " },
    ]) {
      expect(resolveChatAttachment(attachment, { channelId: "chn-1", currentDirectory: "/tmp" }))
        .toMatchObject({ ok: false, status: 403 });
    }
  });

  test("members cannot publish operator-only raw-file URLs", () => {
    for (const url of ["/api/file/raw/tmp/private.html", "http://localhost/api/file/raw/tmp/private.html", "//localhost/api/file/raw/tmp/private.html"]) {
      expect(resolveChatAttachment({ mediaType: "text/html", url }, { channelId: "chn-1", currentDirectory: "/tmp" }))
        .toMatchObject({ ok: false, status: 403 });
    }
  });

  test("members may attach existing same-origin uploads with canonical stored metadata", async () => {
    const root = makeRoot();
    const prior = process.env.OPENSCOUT_CHAT_BLOB_DIR;
    process.env.OPENSCOUT_CHAT_BLOB_DIR = root;
    resetChatBlobStoreForTests();
    try {
      const stored = await putImageBlob({ data: btoa("image"), mediaType: "image/png", fileName: "photo.png" });
      const input = { channelId: "chn-1", currentDirectory: root, requestOrigin: "http://localhost" };
      expect(resolveChatAttachment({ url: `http://localhost/api/blobs/${stored.id}`, mediaType: "text/html" }, input))
        .toMatchObject({ ok: true, attachment: { mediaType: "image/png", blobKey: stored.id, url: `/api/blobs/${stored.id}` } });
      expect(resolveChatAttachment({ url: `http://other/api/blobs/${stored.id}`, mediaType: "image/png" }, input))
        .toMatchObject({ ok: false, status: 403 });
      expect(resolveChatAttachment({ url: "/api/blobs/missing", mediaType: "image/png" }, input))
        .toMatchObject({ ok: false, status: 404 });
    } finally {
      resetChatBlobStoreForTests();
      if (prior === undefined) delete process.env.OPENSCOUT_CHAT_BLOB_DIR;
      else process.env.OPENSCOUT_CHAT_BLOB_DIR = prior;
    }
  });

  test("refuses a path outside trusted roots", () => {
    const root = makeRoot();
    const resolved = resolveChatAttachment(
      { localPath: "/etc/hosts" },
      { channelId: "chn-1", currentDirectory: root, allowLocalPaths: true },
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.status).toBe(403);
  });
});
