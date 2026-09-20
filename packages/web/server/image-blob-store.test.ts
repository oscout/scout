import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  blobServeHeaders,
  getImageBlob,
  putImageBlob,
  resetChatBlobStoreForTests,
} from "./image-blob-store.ts";

describe("blobServeHeaders", () => {
  test("an image says how long it may be held, and that its type is its type", () => {
    const headers = blobServeHeaders({
      mediaType: "image/png",
      size: 4096,
      fileName: "shot.png",
    });
    expect(headers["content-type"]).toBe("image/png");
    expect(headers["content-length"]).toBe("4096");
    expect(headers["cache-control"]).toBe("private, max-age=3600");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-disposition"]).toBe(`inline; filename="shot.png"; filename*=UTF-8''shot.png`);
  });

  test("all media carry a sandbox policy, including parameterized legacy types", () => {
    for (const mediaType of ["text/html", "image/svg+xml", "image/svg+xml;charset=utf8", "Text/Html; charset=UTF-8", "video/mp4"]) {
      const headers = blobServeHeaders({ mediaType, size: 12 });
      expect(headers["content-security-policy"]).toContain("sandbox; default-src 'none'");
      expect(headers["content-type"]).toBe(mediaType.split(";")[0]!.toLowerCase());
    }
  });

  test("a quoted filename cannot break out of the disposition header", () => {
    const headers = blobServeHeaders({
      mediaType: "image/png",
      size: 1,
      fileName: 'we"ird.png',
    });
    expect(headers["content-disposition"]).toBe(`inline; filename="we_ird.png"; filename*=UTF-8''we%22ird.png`);
  });
  test("Unicode and control characters cannot invalidate response headers", () => {
    const headers = blobServeHeaders({ mediaType: "image/png", size: 1, fileName: "你好\r\n.png" });
    expect(() => new Response("x", { headers })).not.toThrow();
    expect(headers["content-disposition"]).toBe(
      "inline; filename=\"____.png\"; filename*=UTF-8''%E4%BD%A0%E5%A5%BD%0D%0A.png",
    );
  });

});

describe("durable chat blobs", () => {
  let dir = "";

  afterEach(async () => {
    resetChatBlobStoreForTests();
    delete process.env.OPENSCOUT_CHAT_BLOB_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("survives an in-memory restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "chat-blobs-"));
    process.env.OPENSCOUT_CHAT_BLOB_DIR = dir;
    const stored = await putImageBlob({
      data: Buffer.from("png-bytes").toString("base64"),
      mediaType: "IMAGE/PNG; charset=utf8",
      fileName: "still.png",
    });
    expect(getImageBlob(stored.id)?.fileName).toBe("still.png");
    resetChatBlobStoreForTests();
    const again = getImageBlob(stored.id);
    expect(again?.id).toBe(stored.id);
    expect(again?.mediaType).toBe("image/png");
    expect(again?.fileName).toBe("still.png");
  });
});
