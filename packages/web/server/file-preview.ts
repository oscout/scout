import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import { queryAgents } from "./db-queries.ts";

const MAX_PREVIEW_BYTES = 256 * 1024;

export type FilePreviewResult =
  | {
      ok: true;
      content: FilePreviewContent;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export type FilePreviewDirectoryEntry = {
  name: string;
  path: string;
  realPath: string;
  kind: "file" | "directory";
};

export type FilePreviewContent =
  | {
      kind: "file";
      previewable: true;
      path: string;
      realPath: string;
      rootPath: string;
      title: string;
      mediaType: string;
      rawUrl: string;
      content: string;
      sizeBytes: number;
      truncated: boolean;
      generatedAt: number;
    }
  | {
      kind: "file";
      previewable: false;
      path: string;
      realPath: string;
      rootPath: string;
      title: string;
      mediaType: string;
      rawUrl: string;
      sizeBytes: number;
      previewReason: string;
      generatedAt: number;
    }
  | {
      kind: "directory";
      previewable: false;
      path: string;
      realPath: string;
      rootPath: string;
      title: string;
      mediaType: "inode/directory";
      entries: FilePreviewDirectoryEntry[];
      generatedAt: number;
    };

export type TrustedRoot = {
  path: string;
  source:
    | "agent-project"
    | "agent-cwd"
    | "current-directory"
    | "workspace-root"
    | "system-temp";
  agentId?: string;
};

/** Roots the operator registered explicitly (settings discovery.workspaceRoots). */
function registeredWorkspaceRoots(): string[] {
  try {
    const raw = readFileSync(resolveOpenScoutSupportPaths().settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { discovery?: { workspaceRoots?: unknown } };
    const roots = parsed.discovery?.workspaceRoots;
    return Array.isArray(roots)
      ? roots.filter((root): root is string => typeof root === "string" && root.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function expand(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

// Root collection walks the agent DB (500 rows) plus a realpath per candidate —
// seconds of latency that every file click and tree expand would otherwise pay.
// The set changes rarely (new agent/new workspace root), so a short TTL is safe.
const TRUSTED_ROOTS_TTL_MS = 15_000;
let trustedRootsCache: { key: string; at: number; roots: TrustedRoot[] } | null = null;

export function collectTrustedRoots(input: { currentDirectory: string }): TrustedRoot[] {
  const cached = trustedRootsCache;
  if (cached && cached.key === input.currentDirectory && Date.now() - cached.at < TRUSTED_ROOTS_TTL_MS) {
    return cached.roots;
  }
  const roots = collectTrustedRootsUncached(input);
  trustedRootsCache = { key: input.currentDirectory, at: Date.now(), roots };
  return roots;
}

function collectTrustedRootsUncached(input: { currentDirectory: string }): TrustedRoot[] {
  const seen = new Map<string, TrustedRoot>();
  const add = (raw: string | null | undefined, source: TrustedRoot["source"], agentId?: string) => {
    if (!raw) return;
    const expanded = expand(raw);
    if (!isAbsolute(expanded)) return;
    let resolved: string;
    try {
      resolved = realpathSync(expanded);
    } catch {
      resolved = resolve(expanded);
    }
    if (seen.has(resolved)) return;
    seen.set(resolved, { path: resolved, source, ...(agentId ? { agentId } : {}) });
  };

  add(input.currentDirectory, "current-directory");

  for (const root of registeredWorkspaceRoots()) {
    add(root, "workspace-root");
  }

  try {
    const agents = queryAgents(500);
    for (const agent of agents) {
      add(agent.projectRoot, "agent-project", agent.id);
      add(agent.cwd, "agent-cwd", agent.id);
    }
  } catch {
    // Broker DB unavailable — fall back to current-directory + temp only.
  }

  // Agents and local tools routinely put short-lived preview artifacts under
  // the platform temp directory. Add temp after durable/live roots so a
  // relative lookup cannot shadow an identically named workspace file.
  // resolveTrustedPath still realpaths the request, so a symlink from temp to
  // somewhere outside these roots remains denied.
  for (const root of systemTempRoots()) {
    add(root, "system-temp");
  }

  return [...seen.values()];
}

function systemTempRoots(): string[] {
  // `tmpdir()` already applies the platform's environment-variable rules. Do
  // not independently trust every lower-priority TMP/TEMP alias: a stale or
  // hostile value could otherwise turn HOME (or even a filesystem root) into
  // a preview grant. POSIX compatibility aliases are not paths on Windows.
  const roots = process.platform === "win32"
    ? [tmpdir()]
    : [tmpdir(), "/tmp", "/private/tmp"];
  return [...new Set(roots
    .map((root) => root?.trim())
    .filter((root): root is string => typeof root === "string" && root.length > 0 && existsSync(root))
    .filter((root) => {
      try {
        const realRoot = realpathSync(root);
        const realHome = realpathSync(homedir());
        return statSync(realRoot).isDirectory()
          && realRoot !== realHome
          && resolve(realRoot, "..") !== realRoot;
      } catch {
        return false;
      }
    }))];
}

function pathInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function findContainingRoot(
  absolutePath: string,
  roots: TrustedRoot[],
): TrustedRoot | null {
  for (const root of roots) {
    if (pathInsideRoot(absolutePath, root.path)) {
      return root;
    }
  }
  return null;
}

export function mediaTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".gz") || lower.endsWith(".tgz")) return "application/gzip";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "text/markdown";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "application/json";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return "text/css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".sh")) return "text/x-shellscript";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "text/yaml";
  if (lower.endsWith(".toml")) return "text/toml";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

function looksTextual(path: string, buffer: Buffer): boolean {
  if (/\.(md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|py|swift|kt|java|go|rs|css|scss|html|sql|sh|xml|log|conf|env|ini|gitignore)$/iu.test(path)) {
    return true;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

function readPreviewBuffer(path: string, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function isRawMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/")
    || mediaType.startsWith("audio/")
    || mediaType.startsWith("video/")
    || mediaType === "application/pdf"
    || mediaType === "application/zip"
    || mediaType === "application/gzip";
}

export function resolveTrustedPath(input: {
  requestedPath: string;
  roots: TrustedRoot[];
}): { ok: true; realPath: string; root: TrustedRoot } | { ok: false; status: number; error: string } {
  const requested = input.requestedPath.trim();
  if (!requested) {
    return { ok: false, status: 400, error: "path is required" };
  }
  const expanded = expand(requested);

  // Absolute path: resolve directly, then verify it sits inside a trusted root.
  if (isAbsolute(expanded)) {
    let realPath: string;
    try {
      realPath = realpathSync(expanded);
    } catch {
      return { ok: false, status: 404, error: "file not found" };
    }
    const root = findContainingRoot(realPath, input.roots);
    if (!root) {
      return { ok: false, status: 403, error: "path is outside Scout's trusted workspace roots" };
    }
    return { ok: true, realPath, root };
  }

  // Relative path: try resolving against each trusted root, in order.
  // First root that yields an existing path inside that root wins.
  const stripped = expanded.replace(/^\.\/+/u, "");
  for (const root of input.roots) {
    const candidate = resolve(root.path, stripped);
    let realCandidate: string;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      continue;
    }
    if (pathInsideRoot(realCandidate, root.path)) {
      return { ok: true, realPath: realCandidate, root };
    }
  }
  return { ok: false, status: 404, error: "file not found in any trusted workspace root" };
}

function rawFileUrl(realPath: string): string {
  const encodedPath = realPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/file/raw${encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`}`;
}

export function readFilePreview(input: {
  requestedPath: string;
  currentDirectory: string;
}): FilePreviewResult {
  const roots = collectTrustedRoots({ currentDirectory: input.currentDirectory });
  const resolved = resolveTrustedPath({ requestedPath: input.requestedPath, roots });
  if (!resolved.ok) {
    return resolved;
  }
  const { realPath, root } = resolved;
  try {
    const stat = statSync(realPath);
    const title = realPath === "/" ? "/" : realPath.split("/").pop() || realPath;
    if (stat.isDirectory()) {
      return {
        ok: true,
        content: {
          kind: "directory",
          previewable: false,
          path: input.requestedPath,
          realPath,
          rootPath: root.path,
          title,
          mediaType: "inode/directory",
          entries: listDirectoryEntries({ realPath, roots }),
          generatedAt: Date.now(),
        },
      };
    }
    if (!stat.isFile()) {
      return { ok: false, status: 415, error: "path is not a file or directory" };
    }
    const mediaType = mediaTypeFor(realPath);
    const rawUrl = rawFileUrl(realPath);
    if (isRawMediaType(mediaType)) {
      return {
        ok: true,
        content: {
          kind: "file",
          previewable: false,
          path: input.requestedPath,
          realPath,
          rootPath: root.path,
          title,
          mediaType,
          rawUrl,
          sizeBytes: stat.size,
          previewReason: previewReasonFor(mediaType),
          generatedAt: Date.now(),
        },
      };
    }
    const truncated = stat.size > MAX_PREVIEW_BYTES;
    const readable = readPreviewBuffer(realPath, Math.min(stat.size, MAX_PREVIEW_BYTES));
    if (!looksTextual(realPath, readable)) {
      return {
        ok: true,
        content: {
          kind: "file",
          previewable: false,
          path: input.requestedPath,
          realPath,
          rootPath: root.path,
          title,
          mediaType,
          rawUrl,
          sizeBytes: stat.size,
          previewReason: previewReasonFor(mediaType),
          generatedAt: Date.now(),
        },
      };
    }
    return {
      ok: true,
      content: {
        kind: "file",
        previewable: true,
        path: input.requestedPath,
        realPath,
        rootPath: root.path,
        title,
        mediaType,
        rawUrl,
        content: readable.toString("utf8"),
        sizeBytes: stat.size,
        truncated,
        generatedAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "could not read file",
    };
  }
}

function previewReasonFor(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "Image file";
  if (mediaType.startsWith("audio/")) return "Audio file";
  if (mediaType.startsWith("video/")) return "Video file";
  if (mediaType === "application/pdf") return "PDF file";
  return "Binary file";
}

function listDirectoryEntries(input: {
  realPath: string;
  roots: TrustedRoot[];
}): FilePreviewDirectoryEntry[] {
  return readdirSync(input.realPath, { withFileTypes: true })
    .flatMap((entry) => {
      const candidate = resolve(input.realPath, entry.name);
      let realEntryPath: string;
      try {
        realEntryPath = realpathSync(candidate);
      } catch {
        realEntryPath = candidate;
      }
      if (!findContainingRoot(realEntryPath, input.roots)) {
        return [];
      }
      let kind: FilePreviewDirectoryEntry["kind"] = "file";
      try {
        kind = statSync(realEntryPath).isDirectory() ? "directory" : "file";
      } catch {
        kind = entry.isDirectory() ? "directory" : "file";
      }
      return [{
        name: entry.name,
        path: realEntryPath,
        realPath: realEntryPath,
        kind,
      }];
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}
