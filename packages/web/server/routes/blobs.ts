import type { Hono } from "hono";
import {
  blobServeHeaders,
  getImageBlob,
  ImageBlobError,
  putImageBlob,
} from "../image-blob-store.ts";
import { fetchLinkPreview } from "../link-preview.ts";
import type { CreateOpenScoutWebServerOptions } from "../web-server-options.ts";
import { blobUploadBody } from "../../shared/api/blobs.ts";
import { readJsonBody } from "../request-body.ts";

export type BlobRouteDeps = {
  options: Pick<CreateOpenScoutWebServerOptions, "publicOrigin">;
};

export function mountBlobRoutes(app: Hono, deps: BlobRouteDeps) {
  const { options } = deps;

  // Chat attachments. Bytes live under Application Support (chat-blobs) so a
  // scout-web restart still serves the still in the thread. The id is the
  // record; nothing else lands in sqlite.
  app.post("/api/blobs", async (c) => {
    const parsed = await readJsonBody(c, blobUploadBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!body.data || !body.mediaType) {
      return c.json({ error: "data and mediaType are required" }, 400);
    }
    try {
      const stored = await putImageBlob({
        data: body.data,
        mediaType: body.mediaType,
        fileName: body.fileName,
      });
      const origin = options.publicOrigin?.trim() || new URL(c.req.url).origin;
      return c.json({
        id: stored.id,
        url: `${origin.replace(/\/$/, "")}/api/blobs/${stored.id}`,
        mediaType: stored.mediaType,
        fileName: stored.fileName,
        size: stored.size,
      });
    } catch (error) {
      if (error instanceof ImageBlobError) {
        return c.json({ error: error.message }, error.status as 400);
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/link-preview", async (c) => {
    const preview = await fetchLinkPreview(c.req.query("url") ?? "");
    if (!preview) return c.json({ error: "no preview" }, 404);
    return c.json({ preview });
  });

  app.get("/api/blobs/:id", (c) => {
    const entry = getImageBlob(c.req.param("id"));
    if (!entry) {
      return c.json({ error: "not found" }, 404);
    }
    // Bun answers a Range request against a BunFile body with a 206 of its
    // own, so a video served from here seeks without any help from us.
    return new Response(Bun.file(entry.path), { headers: blobServeHeaders(entry) });
  });
}
