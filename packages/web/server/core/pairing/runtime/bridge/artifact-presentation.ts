import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * A short-lived, read-only mount of host files for a paired client.
 *
 * This is deliberately not the durable asset store described by SCO-063. A
 * presentation grant keeps a directory-shaped artifact intact so HTML, CSS,
 * images, source maps, and other relative references continue to resolve.
 * The opaque id in the route is the bearer capability; grants are memory-only
 * and disappear on restart.
 */

export const ARTIFACT_PRESENTATION_PATH_PREFIX = "/present/";
export const ARTIFACT_PRESENTATION_DEFAULT_TTL_MS = 30 * 60 * 1000;
export const ARTIFACT_PRESENTATION_MAX_TTL_MS = 6 * 60 * 60 * 1000;

export type ArtifactPresentationGrant = {
  id: string;
  path: string;
  entryPath: string;
  title: string;
  expiresAt: number;
};

type StoredArtifactPresentation = ArtifactPresentationGrant & {
  rootPath: string;
};

export type CreateArtifactPresentationInput = {
  /** A file, or a directory whose relative tree should remain available. */
  sourcePath: string;
  /** Entry within a directory source. Defaults to index.html. */
  entryPath?: string | null;
  title?: string | null;
  ttlMs?: number | null;
};

export type CreateArtifactPresentationOptions = {
  /** The authority boundary (normally the session cwd). */
  allowedRoot: string;
  now?: number;
};

const presentations = new Map<string, StoredArtifactPresentation>();

export function createArtifactPresentation(
  input: CreateArtifactPresentationInput,
  options: CreateArtifactPresentationOptions,
): ArtifactPresentationGrant {
  const now = options.now ?? Date.now();
  purgeExpiredArtifactPresentations(now);

  const allowedRoot = requiredRealDirectory(options.allowedRoot, "allowedRoot");
  if (!isAbsolute(input.sourcePath)) {
    throw new Error("sourcePath must be absolute");
  }

  const sourcePath = requiredRealPath(input.sourcePath, "sourcePath");
  if (!isPathInside(allowedRoot, sourcePath)) {
    throw new Error("sourcePath is outside the session workspace");
  }

  const source = statSync(sourcePath);
  const rootPath = source.isDirectory() ? sourcePath : dirname(sourcePath);
  const entryPath = normalizeRelativeEntry(
    source.isDirectory()
      ? input.entryPath?.trim() || "index.html"
      : basename(sourcePath),
  );
  const entryTarget = requiredRealPath(resolve(rootPath, entryPath), "entryPath");
  if (!isPathInside(rootPath, entryTarget)) {
    throw new Error("entryPath leaves the presentation root");
  }
  if (!statSync(entryTarget).isFile()) {
    throw new Error("entryPath must name a file");
  }

  const id = `present-${randomBytes(24).toString("base64url")}`;
  const ttlMs = normalizedTtl(input.ttlMs);
  const title = input.title?.trim() || basename(entryTarget);
  const grant: StoredArtifactPresentation = {
    id,
    rootPath,
    entryPath,
    title,
    expiresAt: now + ttlMs,
    path: presentationPath(id, entryPath),
  };
  presentations.set(id, grant);
  return publicGrant(grant);
}

export function revokeArtifactPresentation(id: string): boolean {
  return presentations.delete(id.trim());
}

/**
 * Serve a presentation route. Returns null when the URL is not ours so the
 * caller can continue through its own router.
 */
export function serveArtifactPresentation(
  req: Request,
  url: URL,
  now = Date.now(),
): Response | null {
  if (!url.pathname.startsWith(ARTIFACT_PRESENTATION_PATH_PREFIX)) {
    return null;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return presentationResponse("Method not allowed", 405, { allow: "GET, HEAD" });
  }

  purgeExpiredArtifactPresentations(now);
  const parsed = parsePresentationPath(url.pathname);
  if (!parsed) {
    return presentationResponse("Not found", 404);
  }
  const grant = presentations.get(parsed.id);
  if (!grant || grant.expiresAt <= now) {
    if (grant) presentations.delete(grant.id);
    return presentationResponse("Presentation expired", 404);
  }

  let target: string;
  try {
    target = requiredRealPath(resolve(grant.rootPath, parsed.relativePath), "artifact path");
  } catch {
    return presentationResponse("Not found", 404);
  }
  if (!isPathInside(grant.rootPath, target)) {
    return presentationResponse("Forbidden", 403);
  }

  const targetStat = statSync(target);
  if (targetStat.isDirectory()) {
    try {
      target = requiredRealPath(resolve(target, "index.html"), "artifact index");
    } catch {
      return presentationResponse("Not found", 404);
    }
    if (!isPathInside(grant.rootPath, target) || !statSync(target).isFile()) {
      return presentationResponse("Not found", 404);
    }
  } else if (!targetStat.isFile()) {
    return presentationResponse("Not found", 404);
  }

  const file = Bun.file(target);
  const headers = presentationHeaders({
    "content-length": String(file.size),
  });
  return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
}

export function purgeExpiredArtifactPresentations(now = Date.now()): number {
  let purged = 0;
  for (const [id, grant] of presentations) {
    if (grant.expiresAt > now) continue;
    presentations.delete(id);
    purged += 1;
  }
  return purged;
}

function parsePresentationPath(pathname: string): { id: string; relativePath: string } | null {
  const raw = pathname.slice(ARTIFACT_PRESENTATION_PATH_PREFIX.length);
  const slash = raw.indexOf("/");
  if (slash <= 0) return null;

  let id: string;
  let relativePath: string;
  try {
    id = decodeURIComponent(raw.slice(0, slash)).trim();
    relativePath = raw
      .slice(slash + 1)
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    return null;
  }
  if (!id || id.includes("/") || id.includes("\\")) return null;
  try {
    return { id, relativePath: normalizeRelativeEntry(relativePath || "index.html") };
  } catch {
    return null;
  }
}

function presentationPath(id: string, entryPath: string): string {
  const encodedEntry = entryPath.split("/").map(encodeURIComponent).join("/");
  return `${ARTIFACT_PRESENTATION_PATH_PREFIX}${encodeURIComponent(id)}/${encodedEntry}`;
}

function normalizeRelativeEntry(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized === ".") {
    throw new Error("entryPath is required");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("entryPath must stay within the presentation root");
  }
  return parts.join("/");
}

function requiredRealDirectory(path: string, label: string): string {
  const real = requiredRealPath(path, label);
  if (!statSync(real).isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return real;
}

function requiredRealPath(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`${label} does not exist`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizedTtl(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return ARTIFACT_PRESENTATION_DEFAULT_TTL_MS;
  }
  return Math.max(1_000, Math.min(ARTIFACT_PRESENTATION_MAX_TTL_MS, Math.floor(value)));
}

function publicGrant(grant: StoredArtifactPresentation): ArtifactPresentationGrant {
  return {
    id: grant.id,
    path: grant.path,
    entryPath: grant.entryPath,
    title: grant.title,
    expiresAt: grant.expiresAt,
  };
}

function presentationHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    ...extra,
  });
}

function presentationResponse(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: presentationHeaders({
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    }),
  });
}
