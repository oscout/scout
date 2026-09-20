/** Shared allowlists for routed capture attachments (native + web). */

export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "heic",
  "heif",
  "bmp",
]);

export const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "m4v",
]);

export const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "oga",
]);

export const MARKDOWN_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdx",
  "mdown",
  "mkd",
]);

export const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "cjs",
  "mjs",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "pyw",
  "pyi",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "swift",
  "cs",
  "rb",
  "php",
  "lua",
  "r",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "prisma",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  "graphql",
  "gql",
  "zig",
  "ex",
  "exs",
  "erl",
  "hrl",
  "hs",
  "clj",
  "cljs",
  "cljc",
  "dart",
  "tf",
  "hcl",
  "nix",
  "env",
  "ini",
  "cfg",
  "conf",
  "properties",
  "txt",
  "log",
  "cmake",
  "gradle",
  "groovy",
  "patch",
  "diff",
  "proto",
  "wat",
]);

export const CODE_BASENAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "gemfile",
  "rakefile",
  "procfile",
  "brewfile",
]);

const STRUCTURED_TEXT_MEDIA_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "text/javascript",
  "text/typescript",
  "text/css",
  "text/html",
  "text/yaml",
  "text/toml",
  "text/x-shellscript",
  "application/json",
  "application/javascript",
]);

export function captureFileBaseName(fileName: string): string {
  const trimmed = fileName.trim();
  return trimmed.split(/[/\\]/).pop()?.toLowerCase() ?? "";
}

export function captureFileExtension(fileName: string): string {
  const base = captureFileBaseName(fileName);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
}

export function isMarkdownFileName(fileName: string): boolean {
  return MARKDOWN_EXTENSIONS.has(captureFileExtension(fileName));
}

export function isCodeFileName(fileName: string): boolean {
  const base = captureFileBaseName(fileName);
  if (CODE_BASENAMES.has(base)) return true;
  return CODE_EXTENSIONS.has(captureFileExtension(fileName));
}

export function isTextCaptureFileName(fileName: string): boolean {
  return isMarkdownFileName(fileName) || isCodeFileName(fileName);
}

export function resolveTextCaptureMediaType(
  mediaType: string,
  fileName: string,
): string | null {
  if (!isTextCaptureFileName(fileName)) return null;
  const ext = captureFileExtension(fileName);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "text/markdown";
  switch (ext) {
    case "json":
    case "jsonc":
    case "json5":
      return "application/json";
    case "yaml":
    case "yml":
      return "text/yaml";
    case "toml":
      return "text/toml";
    case "html":
    case "htm":
    case "xhtml":
      return "text/html";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "text/css";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "text/javascript";
    case "ts":
    case "tsx":
      return "text/typescript";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "text/x-shellscript";
    default:
      break;
  }
  const normalized = mediaType.trim().toLowerCase();
  if (STRUCTURED_TEXT_MEDIA_TYPES.has(normalized)) return normalized;
  return "text/plain";
}

export function isImageFileName(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(captureFileExtension(fileName));
}

export function isVideoFileName(fileName: string): boolean {
  return VIDEO_EXTENSIONS.has(captureFileExtension(fileName));
}

export function isAudioFileName(fileName: string): boolean {
  return AUDIO_EXTENSIONS.has(captureFileExtension(fileName));
}

export function isRoutableCaptureMediaType(mediaType: string, fileName?: string): boolean {
  const type = mediaType.trim().toLowerCase();
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) return true;
  if (type === "text/markdown" || type === "text/x-markdown") return true;
  if (!fileName) return false;
  if (isImageFileName(fileName) || isVideoFileName(fileName) || isAudioFileName(fileName)) return true;
  if (resolveTextCaptureMediaType(type, fileName)) return true;
  if (!type || type === "application/octet-stream") {
    return isTextCaptureFileName(fileName);
  }
  return false;
}

export function resolvedCaptureUploadMediaType(file: Pick<File, "type" | "name">): string {
  const type = file.type.trim().toLowerCase();
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) return type;
  const ext = captureFileExtension(file.name);
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "svg") return "image/svg+xml";
    return `image/${ext}`;
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    if (ext === "mov") return "video/quicktime";
    if (ext === "m4v") return "video/mp4";
    return `video/${ext}`;
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    if (ext === "mp3") return "audio/mpeg";
    if (ext === "m4a") return "audio/mp4";
    if (ext === "oga") return "audio/ogg";
    return `audio/${ext}`;
  }
  return resolveTextCaptureMediaType(type, file.name) ?? type;
}