import { statSync } from "node:fs";
import { basename } from "node:path";
import type { Context } from "hono";
import { blobServeHeaders } from "./image-blob-store.ts";
import { collectTrustedRoots, mediaTypeFor, resolveTrustedPath } from "./file-preview.ts";

export function parseOptionalPositiveInt(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function serveRawFile(
  c: Context,
  currentDirectory: string,
  requestedPath: string | null | undefined,
): Response {
  if (!requestedPath) {
    return c.json({ error: "missing path" }, 400);
  }
  const roots = collectTrustedRoots({ currentDirectory });
  const resolved = resolveTrustedPath({ requestedPath, roots });
  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status as 400 | 403 | 404);
  }
  try {
    if (!statSync(resolved.realPath).isFile()) {
      return c.json({ error: "path is not a file" }, 415);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not read file";
    return c.json({ error: message }, 500);
  }
  const mediaType = mediaTypeFor(resolved.realPath);
  const headers = blobServeHeaders({
    mediaType,
    size: Bun.file(resolved.realPath).size,
    fileName: basename(resolved.realPath),
  });
  headers["cache-control"] = "private, max-age=15";
  return new Response(Bun.file(resolved.realPath), { headers });
}
