import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTextCaptureMediaType } from "../client/lib/capture-attachments.ts";

// Ephemeral, session-scoped capture storage (markdown, code, images, clips).
// These blobs are caches, not records: they live just long enough for an agent
// to fetch an attachment the first time it sees a message. We optimize for
// delivery success (the file is present and fast on first fetch), not
// durability — if a blob is gone after its TTL, that is expected and fine.
// Nothing here touches the database.

const BLOB_DIR = join(tmpdir(), "openscout-image-blobs");
// Comfortable window so a blob is reliably present on the agent's first fetch.
// Generous on purpose: first-fetch reliability beats reclaiming disk early.
const BLOB_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_BLOB_BYTES = 25 * 1024 * 1024; // 25 MB

export type ImageBlobEntry = {
  id: string;
  path: string;
  mediaType: string;
  fileName?: string;
  size: number;
  expiresAt: number;
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
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let dirReady: Promise<void> | null = null;

function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(BLOB_DIR, { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

function ensureSweeper(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    void sweepExpired();
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just to reclaim cache files.
  sweepTimer.unref?.();
}

async function sweepExpired(now = Date.now()): Promise<void> {
  for (const entry of [...entries.values()]) {
    if (entry.expiresAt <= now) {
      entries.delete(entry.id);
      await rm(entry.path, { force: true }).catch(() => {});
    }
  }
}

function normalizeMediaType(raw: string, fileName?: string): string {
  const value = raw.trim().toLowerCase();
  if (value.startsWith("image/") || value.startsWith("video/")) {
    return value;
  }
  const resolvedName = fileName?.trim();
  if (resolvedName) {
    const textCapture = resolveTextCaptureMediaType(value, resolvedName);
    if (textCapture) return textCapture;
  }
  throw new ImageBlobError(
    "Only markdown, code, image, and video attachments are supported",
    415,
  );
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
  ensureSweeper();

  const id = randomUUID();
  const path = join(BLOB_DIR, id);
  await writeFile(path, bytes);

  const entry: ImageBlobEntry = {
    id,
    path,
    mediaType,
    fileName: input.fileName?.trim() || undefined,
    size: bytes.length,
    expiresAt: Date.now() + BLOB_TTL_MS,
  };
  entries.set(id, entry);

  return {
    id: entry.id,
    mediaType: entry.mediaType,
    fileName: entry.fileName,
    size: entry.size,
  };
}

/**
 * Resolve a blob for serving. Returns null when unknown or expired. Reads never
 * delete the blob — an agent may fetch the same attachment more than once.
 */
export function getImageBlob(id: string): ImageBlobEntry | null {
  const entry = entries.get(id);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    entries.delete(id);
    void rm(entry.path, { force: true }).catch(() => {});
    return null;
  }
  return entry;
}
