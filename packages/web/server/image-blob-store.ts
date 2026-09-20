import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertTestIsolatedUserData, resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import { resolveTextCaptureMediaType } from "../client/lib/capture-attachments.ts";

/**
 * Chat attachments are records, not a temp cache. Bytes live under
 * Application Support (or OPENSCOUT_CHAT_BLOB_DIR) with an index so a
 * scout-web restart still serves the still in the thread.
 */

const INDEX_NAME = "index.json";
const MAX_BLOB_BYTES = 25 * 1024 * 1024; // 25 MB

export type ImageBlobEntry = {
  id: string;
  path: string;
  mediaType: string;
  fileName?: string;
  size: number;
  createdAt: number;
};

type IndexRecord = {
  id: string;
  mediaType: string;
  fileName?: string;
  size: number;
  createdAt: number;
};

export type PutImageBlobInput = {
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
  mediaType: string;
  fileName?: string;
};

export type PutImageBlobResult = {
  id: string;
  mediaType: string;
  fileName?: string;
  size: number;
};

export class ImageBlobError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ImageBlobError";
  }
}

const entries = new Map<string, ImageBlobEntry>();
let loaded = false;
let dirReady: Promise<void> | null = null;

export function chatBlobDirectory(): string {
  const fromEnv = process.env.OPENSCOUT_CHAT_BLOB_DIR?.trim();
  if (fromEnv) return fromEnv;
  assertTestIsolatedUserData("write chat blobs", "OPENSCOUT_SUPPORT_DIRECTORY");
  try {
    return join(resolveOpenScoutSupportPaths().supportDirectory, "chat-blobs");
  } catch {
    return join(tmpdir(), "openscout-chat-blobs");
  }
}

function indexPath(): string {
  return join(chatBlobDirectory(), INDEX_NAME);
}

function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(chatBlobDirectory(), { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

function persistIndex(): void {
  const records: IndexRecord[] = [...entries.values()].map((entry) => ({
    id: entry.id,
    mediaType: entry.mediaType,
    fileName: entry.fileName,
    size: entry.size,
    createdAt: entry.createdAt,
  }));
  const root = chatBlobDirectory();
  const tmp = join(root, `${INDEX_NAME}.tmp`);
  writeFileSync(tmp, JSON.stringify({ blobs: records }));
  renameSync(tmp, indexPath());
}

function loadIndex(): void {
  if (loaded) return;
  loaded = true;
  const root = chatBlobDirectory();
  const file = join(root, INDEX_NAME);
  if (!existsSync(file)) return;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { blobs?: IndexRecord[] };
    for (const record of parsed.blobs ?? []) {
      if (!record?.id || !record.mediaType) continue;
      const path = join(root, record.id);
      if (!existsSync(path)) continue;
      entries.set(record.id, {
        id: record.id,
        path,
        mediaType: record.mediaType,
        fileName: record.fileName,
        size: record.size,
        createdAt: record.createdAt || 0,
      });
    }
  } catch {
    // A corrupt index is not a reason to refuse new uploads.
  }
}

/** Tests only: drop the in-memory map so the next read reloads from disk. */
export function resetChatBlobStoreForTests(): void {
  entries.clear();
  loaded = false;
  dirReady = null;
}

function canonicalMediaType(raw: string): string {
  const value = raw.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
    ? value : "application/octet-stream";
}

function normalizeMediaType(raw: string, fileName?: string): string {
  const value = canonicalMediaType(raw);
  if (value.startsWith("image/") || value.startsWith("video/") || value.startsWith("audio/")) {
    return value;
  }
  const resolvedName = fileName?.trim();
  if (resolvedName) {
    const textCapture = resolveTextCaptureMediaType(value, resolvedName);
    if (textCapture) return textCapture;
  }
  throw new ImageBlobError(
    "Only markdown, code, image, video, and audio attachments are supported",
    415,
  );
}

/**
 * How a stored blob is handed back, wherever it is reached from.
 *
 * `/api/blobs/:id` and the channel attachment route serve the same bytes to
 * the same browsers, so they say the same things about them: how long it may
 * be held, that the declared type is the type, and a sandbox policy for every response, including legacy media metadata
 * and direct navigation outside the attachment iframe.
 */
export function blobServeHeaders(entry: {
  mediaType: string;
  size: number;
  fileName?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": canonicalMediaType(entry.mediaType),
    "cache-control": "private, max-age=3600",
    "content-length": String(entry.size),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
  };
  if (entry.fileName) {
    const fallback = entry.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(entry.fileName)))
      .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    headers["content-disposition"] = `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  }
  return headers;
}

export async function putImageBlob(
  input: PutImageBlobInput,
): Promise<PutImageBlobResult> {
  const mediaType = normalizeMediaType(input.mediaType, input.fileName);
  if (!input.data) {
    throw new ImageBlobError("Missing image data", 400);
  }

  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length === 0) {
    throw new ImageBlobError("Image data is empty or not valid base64", 400);
  }
  if (bytes.length > MAX_BLOB_BYTES) {
    throw new ImageBlobError("Image exceeds the maximum allowed size", 413);
  }

  await ensureDir();
  loadIndex();

  const id = randomUUID();
  const path = join(chatBlobDirectory(), id);
  await writeFile(path, bytes);

  const entry: ImageBlobEntry = {
    id,
    path,
    mediaType,
    fileName: input.fileName?.trim() || undefined,
    size: bytes.length,
    createdAt: Date.now(),
  };
  entries.set(id, entry);
  persistIndex();

  return {
    id: entry.id,
    mediaType: entry.mediaType,
    fileName: entry.fileName,
    size: entry.size,
  };
}

/**
 * Resolve a blob for serving. Returns null when unknown. Reads never delete
 * the blob — an agent may fetch the same attachment more than once, and a
 * thread still needs the still after scout-web restarts.
 */
export function getImageBlob(id: string): ImageBlobEntry | null {
  loadIndex();
  const entry = entries.get(id);
  if (!entry) return null;
  if (!existsSync(entry.path)) {
    entries.delete(id);
    persistIndex();
    return null;
  }
  return entry;
}
