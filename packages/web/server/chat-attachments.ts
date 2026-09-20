import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import type { MessageAttachment } from "@openscout/protocol";

import { collectTrustedRoots, mediaTypeFor, resolveTrustedPath } from "./file-preview.ts";

import { getImageBlob } from "./image-blob-store.ts";

const LOCAL_BLOB_PREFIX = "local:";

export type IncomingChatAttachment = {
  id?: string;
  mediaType?: string;
  fileName?: string;
  url?: string;
  blobKey?: string;
  localPath?: string;
  metadata?: Record<string, unknown> | null;
};

export function isLocalAttachmentKey(blobKey: string | undefined): blobKey is `local:${string}` {
  return typeof blobKey === "string" && blobKey.trim().startsWith(LOCAL_BLOB_PREFIX);
}

export function localPathFromBlobKey(blobKey: string | undefined): string | null {
  return isLocalAttachmentKey(blobKey) ? blobKey.trim().slice(LOCAL_BLOB_PREFIX.length) : null;
}

export function chatAttachmentUrl(channelId: string, attachmentId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export function rawFileUrl(realPath: string): string {
  const encodedPath = realPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/file/raw${encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`}`;
}

/**
 * Turn a posted attachment into something the feed can serve.
 *
 * A path inside Scout's trusted roots (workspace roots, agent cwds, temp) is
 * kept as a live file pointer — no copy, no TTL. Anything else must already
 * be an uploaded blob URL. Guessing a path outside those roots fails closed.
 */
export function resolveChatAttachment(
  incoming: IncomingChatAttachment,
  input: { channelId: string; currentDirectory: string; allowLocalPaths?: boolean; requestOrigin?: string },
): { ok: true; attachment: MessageAttachment } | { ok: false; status: 400 | 403 | 404; error: string } {
  const hasLocalPointer = typeof incoming.localPath === "string"
    || typeof incoming.metadata?.localPath === "string"
    || isLocalAttachmentKey(incoming.blobKey);
  if (hasLocalPointer && !input.allowLocalPaths) {
    return { ok: false, status: 403, error: "local file attachments require operator authority" };
  }
  const localPath = typeof incoming.localPath === "string"
    ? incoming.localPath
    : typeof incoming.metadata?.localPath === "string"
      ? incoming.metadata.localPath
      : localPathFromBlobKey(incoming.blobKey);
  if (localPath?.trim()) {
    const roots = collectTrustedRoots({ currentDirectory: input.currentDirectory });
    const resolved = resolveTrustedPath({ requestedPath: localPath.trim(), roots });
    if (!resolved.ok) {
      return { ok: false, status: resolved.status as 400 | 403 | 404, error: resolved.error };
    }
    const id = incoming.id?.trim() || `att-${randomUUID()}`;
    const fileName = incoming.fileName?.trim() || basename(resolved.realPath);
    return {
      ok: true,
      attachment: {
        id,
        mediaType: incoming.mediaType?.trim() || mediaTypeFor(resolved.realPath),
        fileName,
        blobKey: `${LOCAL_BLOB_PREFIX}${resolved.realPath}`,
        url: chatAttachmentUrl(input.channelId, id),
        metadata: { kind: "local-path" },
      },
    };
  }

  let normalizedUrl = incoming.url?.trim();
  if (!input.allowLocalPaths && normalizedUrl && input.requestOrigin) {
    try {
      const parsed = new URL(normalizedUrl, input.requestOrigin);
      if (parsed.origin === input.requestOrigin && !parsed.username && !parsed.password) {
        normalizedUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch { /* The strict relative-path check below denies malformed URLs. */ }
  }
  if (!input.allowLocalPaths && incoming.url) {
    // A channel grant cannot publish links to operator-only local HTTP resources.
    // Relative uploaded-blob URLs are the only admitted member URL shape.
    if (!/^\/api\/blobs\/[a-zA-Z0-9_-]+$/.test(normalizedUrl ?? "")) {
      return { ok: false, status: 403, error: "member attachments require an uploaded blob URL" };
    }
  }
  const mediaType = incoming.mediaType?.trim();
  const url = normalizedUrl;
  const blobKey = incoming.blobKey?.trim();
  if (!input.allowLocalPaths) {
    const blobId = url?.match(/^\/api\/blobs\/([a-zA-Z0-9_-]+)$/)?.[1] ?? blobKey;
    if (!blobId || !/^[a-zA-Z0-9_-]+$/.test(blobId) || (blobKey && blobKey !== blobId)) {
      return { ok: false, status: 403, error: "member attachments require an uploaded blob" };
    }
    const stored = getImageBlob(blobId);
    if (!stored) return { ok: false, status: 404, error: "uploaded blob not found" };
    return {
      ok: true,
      attachment: {
        id: incoming.id?.trim() || `att-${randomUUID()}`,
        mediaType: stored.mediaType,
        fileName: stored.fileName,
        blobKey: stored.id,
        url: `/api/blobs/${stored.id}`,
      },
    };
  }
  if (!mediaType || (!url && !blobKey)) {
    return { ok: false, status: 400, error: "attachment needs a localPath or an uploaded blob" };
  }
  return {
    ok: true,
    attachment: {
      id: incoming.id?.trim() || `att-${randomUUID()}`,
      mediaType,
      fileName: incoming.fileName?.trim() || undefined,
      url: url || undefined,
      blobKey: blobKey || undefined,
    },
  };
}

export function resolveChatAttachments(
  incoming: IncomingChatAttachment[] | undefined,
  input: { channelId: string; currentDirectory: string; allowLocalPaths?: boolean; requestOrigin?: string },
): { ok: true; attachments: MessageAttachment[] } | { ok: false; status: 400 | 403 | 404; error: string } {
  if (!incoming?.length) return { ok: true, attachments: [] };
  const attachments: MessageAttachment[] = [];
  for (const item of incoming) {
    const resolved = resolveChatAttachment(item, input);
    if (!resolved.ok) return resolved;
    attachments.push(resolved.attachment);
  }
  return { ok: true, attachments };
}
