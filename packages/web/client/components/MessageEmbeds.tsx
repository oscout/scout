import { useState } from "react";
import type { Message, MessageAttachment } from "../lib/types.ts";

type LinkPreview = {
  id: string;
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
};

const IMAGE_EXTENSION_PATTERN = /\.(?:apng|avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/iu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/giu;

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.mediaType.toLowerCase().startsWith("image/");
}

function isImageUrl(value: string): boolean {
  return IMAGE_EXTENSION_PATTERN.test(value);
}

function urlLabel(value: string): { host: string; detail: string } {
  try {
    const parsed = new URL(value);
    const detail = [parsed.pathname === "/" ? "" : parsed.pathname, parsed.search]
      .join("")
      .trim();
    return {
      host: parsed.hostname.replace(/^www\./iu, ""),
      detail: detail || parsed.hostname,
    };
  } catch {
    return { host: value, detail: value };
  }
}

function bodyUrls(body: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of body.matchAll(URL_PATTERN)) {
    const cleaned = match[0]?.replace(/[.,;:!?]+$/u, "");
    const url = safeHttpUrl(cleaned);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

const BLOB_PATH_PATTERN = /^\/api\/blobs\/[^/]+$/u;

/**
 * Blob URLs are minted with the server's configured public origin (for example
 * `http://scout.local`), but the page is served from whichever hostname the
 * browser used (`http://dev-mac-mini.scout.local`). Loading the image from the
 * minted origin fails twice over: the web auth cookie is host-only, so the
 * request is 401, and `/api/*` answers with `Cross-Origin-Resource-Policy:
 * same-origin`, which blocks the load even when a cookie is present. Both
 * hostnames reach the same blob store, so render blob attachments through a
 * same-origin path instead of the absolute URL.
 */
export function sameOriginBlobUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return BLOB_PATH_PATTERN.test(parsed.pathname) ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}

function attachmentUrl(attachment: MessageAttachment): string | null {
  return safeHttpUrl(attachment.url)
    ?? safeHttpUrl(metadataString(attachment.metadata, "url"))
    ?? safeHttpUrl(metadataString(attachment.metadata, "href"));
}

function linkPreviewFromAttachment(attachment: MessageAttachment): LinkPreview | null {
  const metadata = attachment.metadata ?? null;
  const kind = metadataString(metadata, "kind") ?? metadataString(metadata, "type");
  const url = attachmentUrl(attachment);
  if (!url || (kind !== "link_preview" && kind !== "link-preview" && attachment.mediaType !== "text/x-uri")) {
    return null;
  }

  const label = urlLabel(url);
  return {
    id: attachment.id,
    url,
    title: metadataString(metadata, "title") ?? label.host,
    description: metadataString(metadata, "description"),
    imageUrl: safeHttpUrl(metadataString(metadata, "imageUrl") ?? metadataString(metadata, "image")),
    siteName: metadataString(metadata, "siteName") ?? label.host,
  };
}

function ImageEmbed({
  src,
  alt,
}: {
  src: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);

  // Blobs expire, and a capture routed from another machine may not exist here.
  // A broken <img> renders as a torn-page glyph in an oversized frame, so fall
  // back to the same file chip an unrenderable attachment already gets.
  if (failed) {
    return (
      <a className="s-message-embed s-message-embed--file" href={src} target="_blank" rel="noreferrer">
        <span className="s-message-embed-title">{alt}</span>
        <span className="s-message-embed-description">Preview unavailable</span>
      </a>
    );
  }

  return (
    <a className="s-message-embed s-message-embed--image" href={src} target="_blank" rel="noreferrer">
      <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </a>
  );
}

function LinkEmbed({ preview }: { preview: LinkPreview }) {
  return (
    <a className="s-message-embed s-message-embed--link" href={preview.url} target="_blank" rel="noreferrer">
      {preview.imageUrl && (
        <span className="s-message-embed-thumb">
          <img src={preview.imageUrl} alt="" loading="lazy" decoding="async" />
        </span>
      )}
      <span className="s-message-embed-copy">
        {preview.siteName && <span className="s-message-embed-site">{preview.siteName}</span>}
        <span className="s-message-embed-title">{preview.title}</span>
        {preview.description && <span className="s-message-embed-description">{preview.description}</span>}
      </span>
    </a>
  );
}

export function MessageEmbeds({ message }: { message: Message }) {
  const attachments = message.attachments ?? [];
  const renderedAttachmentIds = new Set<string>();
  const imageEmbeds: Array<{ id: string; src: string; alt: string }> = [];
  const linkPreviews: LinkPreview[] = [];

  for (const attachment of attachments) {
    const url = attachmentUrl(attachment);
    if (url && isImageAttachment(attachment)) {
      renderedAttachmentIds.add(attachment.id);
      imageEmbeds.push({
        id: attachment.id,
        src: sameOriginBlobUrl(url),
        alt: attachment.fileName ?? "Image attachment",
      });
      continue;
    }

    const preview = linkPreviewFromAttachment(attachment);
    if (preview) {
      renderedAttachmentIds.add(attachment.id);
      linkPreviews.push(preview);
    }
  }

  const attachmentPreviewUrls = new Set(linkPreviews.map((preview) => preview.url));
  const attachmentUrls = new Set(
    attachments
      .map(attachmentUrl)
      .filter((url): url is string => Boolean(url)),
  );
  for (const url of bodyUrls(message.body)) {
    // The message body is already linkified by MessageMarkup. Only turn a bare
    // body URL into an embed when it is unambiguously an image. Synthesizing a
    // "preview" from the URL alone repeats the host/path in a large empty card
    // (especially for local /api/blobs links) without adding any information.
    // Attachments and real link-preview records carry the metadata needed for
    // a useful rich embed, and must not be rendered a second time from the body.
    if (attachmentUrls.has(url) || attachmentPreviewUrls.has(url)) {
      continue;
    }
    if (isImageUrl(url)) {
      imageEmbeds.push({ id: url, src: sameOriginBlobUrl(url), alt: "Embedded image" });
    }
  }

  const fileAttachments = attachments.filter((attachment) => !renderedAttachmentIds.has(attachment.id));
  if (imageEmbeds.length === 0 && linkPreviews.length === 0 && fileAttachments.length === 0) {
    return null;
  }

  return (
    <div className="s-message-embeds">
      {imageEmbeds.map((image) => (
        <ImageEmbed key={image.id} src={image.src} alt={image.alt} />
      ))}
      {linkPreviews.slice(0, 1).map((preview) => (
        <LinkEmbed key={preview.id} preview={preview} />
      ))}
      {fileAttachments.map((attachment) => {
        const rawUrl = attachmentUrl(attachment);
        const url = rawUrl ? sameOriginBlobUrl(rawUrl) : null;
        const label = attachment.fileName ?? metadataString(attachment.metadata, "title") ?? attachment.mediaType;
        return url ? (
          <a key={attachment.id} className="s-message-embed s-message-embed--file" href={url} target="_blank" rel="noreferrer">
            <span className="s-message-embed-title">{label}</span>
            <span className="s-message-embed-description">{attachment.mediaType}</span>
          </a>
        ) : (
          <div key={attachment.id} className="s-message-embed s-message-embed--file">
            <span className="s-message-embed-title">{label}</span>
            <span className="s-message-embed-description">{attachment.mediaType}</span>
          </div>
        );
      })}
    </div>
  );
}
