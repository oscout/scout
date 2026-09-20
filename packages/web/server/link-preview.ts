import { isIP } from "node:net";

export type LinkPreview = {
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
};

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/giu;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_URLS_PER_BODY = 3;
const MAX_REDIRECTS = 3;
/** GitHub's documented OG CDN. The leading hash is a cache key; `1` is stable. */
const GITHUB_OPENGRAPH_IMAGE_BASE = "https://opengraph.githubassets.com/1";

export class LinkPreviewCache {
  private readonly entries = new Map<string, { preview: LinkPreview | null; expiresAt: number }>();
  constructor(private readonly capacity = 256) {}
  get(url: string): { preview: LinkPreview | null; expiresAt: number } | undefined {
    const entry = this.entries.get(url);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(url);
      return undefined;
    }
    return entry;
  }
  set(url: string, entry: { preview: LinkPreview | null; expiresAt: number }): void {
    this.entries.delete(url);
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    if (this.capacity > 0) this.entries.set(url, entry);
  }
}
const cache = new LinkPreviewCache();

/** Only operator-selected, trusted DNS authorities may initiate server-side requests.
 * Arbitrary public-looking hosts are not safe: DNS can change between validation
 * and connection. Expand this allowlist only after reviewing the host authority.
 */
export function supportedPreviewUrl(value: string): string | null {
  const safe = safePublicHttpUrl(value);
  if (!safe || safe.length > 4096) return null;
  const url = new URL(safe);
  return url.protocol === "https:" && !url.port && !url.username && !url.password
    && ["github.com", "www.github.com"].includes(url.hostname) ? safe : null;
}

export async function readBoundedHtml(response: Response, limit = MAX_HTML_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let remaining = limit;
  let html = "";
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      html += decoder.decode(chunk, { stream: true });
      remaining -= chunk.byteLength;
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function extractHttpUrls(body: string, limit = MAX_URLS_PER_BODY): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of body.matchAll(URL_PATTERN)) {
    const cleaned = match[0]?.replace(/[.,;:!?)]+$/u, "") ?? "";
    const url = safePublicHttpUrl(cleaned);
    if (!url || seen.has(url) || url.includes("/api/blobs/")) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

export function safePublicHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.username || url.password) return null;
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (isPrivateIp(host)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isPrivateIp(host: string): boolean {
  const ip = isIP(host) ? host : "";
  if (!ip) return false;
  // IPv6 URLs are valid links, but literal addresses are excluded from previews
  // rather than maintaining a fragile list of special-use IPv6 ranges.
  if (isIP(ip) === 6) return true;
  const octets = ip.split(".").map(Number);
  if (octets[0] === 0 || (octets[0] ?? 0) >= 224) return true;
  if (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) return true;
  if (ip.startsWith("198.18.") || ip.startsWith("198.19.") || ip.startsWith("192.0.0.")) return true;
  if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) {
    return true;
  }
  if (ip.startsWith("192.0.2.") || ip.startsWith("192.88.99.") || ip.startsWith("198.51.100.") || ip.startsWith("203.0.113.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const octet = Number(m[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&nbsp;/giu, " ")
    .trim();
}

function metaContent(html: string, key: string): string | null {
  const property = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "iu"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return null;
}

function titleTag(html: string): string | null {
  const match = /<title[^>]*>([^<]+)<\/title>/iu.exec(html);
  return match?.[1] ? decodeHtml(match[1]) : null;
}

export function parseOpenGraph(html: string, url: string): LinkPreview {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./iu, "");
  const image = metaContent(html, "og:image")
    ?? metaContent(html, "og:image:url")
    ?? metaContent(html, "twitter:image")
    ?? metaContent(html, "twitter:image:src");
  let imageUrl: string | null = null;
  if (image) {
    try {
      imageUrl = new URL(image, url).toString();
      if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) imageUrl = null;
    } catch {
      imageUrl = null;
    }
  }
  return {
    url,
    title: metaContent(html, "og:title") ?? metaContent(html, "twitter:title") ?? titleTag(html) ?? host,
    description: metaContent(html, "og:description") ?? metaContent(html, "twitter:description") ?? metaContent(html, "description"),
    imageUrl,
    siteName: metaContent(html, "og:site_name") ?? host,
  };
}

export function githubOpenGraphFallback(url: string): LinkPreview | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
    const parts = parsed.pathname.replace(/\/+$/u, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo, kind, num] = parts;
    const path = kind && num && ["pull", "issues", "commit"].includes(kind)
      ? `${owner}/${repo}/${kind}/${num}`
      : `${owner}/${repo}`;
    return {
      url,
      title: path.replace(/\//g, " / "),
      description: null,
      imageUrl: `${GITHUB_OPENGRAPH_IMAGE_BASE}/${path}`,
      siteName: "GitHub",
    };
  } catch {
    return null;
  }
}

async function fetchPublicHtml(startUrl: string): Promise<{ html: string; finalUrl: string } | null> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!supportedPreviewUrl(current)) return null;
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "OpenScoutChat/1.0 (+https://openscout.app)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) return null;
      const next = supportedPreviewUrl(new URL(location, current).toString());
      if (!next) return null;
      current = next;
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.toLowerCase().includes("html")) {
      await response.body?.cancel();
      return null;
    }
    const html = await readBoundedHtml(response);
    return {
      html,
      finalUrl: current,
    };
  }
  return null;
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
  const url = supportedPreviewUrl(rawUrl);
  if (!url) return null;
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.preview;
  const github = githubOpenGraphFallback(url);
  try {
    const fetched = await fetchPublicHtml(url);
    if (!fetched) {
      cache.set(url, { preview: github, expiresAt: Date.now() + PREVIEW_TTL_MS });
      return github;
    }
    const preview = parseOpenGraph(fetched.html, fetched.finalUrl);
    preview.url = url;
    if (!preview.imageUrl && github?.imageUrl) preview.imageUrl = github.imageUrl;
    if (github && preview.siteName === new URL(url).hostname.replace(/^www\./iu, "")) {
      preview.siteName = "GitHub";
    }
    cache.set(url, { preview, expiresAt: Date.now() + PREVIEW_TTL_MS });
    return preview;
  } catch {
    cache.set(url, { preview: github, expiresAt: Date.now() + PREVIEW_TTL_MS });
    return github;
  }
}
