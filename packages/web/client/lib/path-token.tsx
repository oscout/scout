import { useScout } from "../scout/Provider.tsx";

/* ── Filepath detection ──────────────────────────────────────────────────
 *
 * Matches paths likely to be filesystem references:
 *   - absolute paths starting with `/` (e.g. `/Users/arach/...`)
 *   - home-relative paths starting with `~/`
 *   - rooted relative paths (`./foo`, `../foo`)
 *   - file-like tokens with a recognized extension and at least one `/`
 *     (e.g. `packages/web/client/app.css`)
 *
 * Tokens with surrounding whitespace boundaries are required so this never
 * eats things like `/release/v1/api` inside a sentence about API routes.
 */
const FILE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "md", "mdx", "txt", "log",
  "json", "jsonc", "yaml", "yml", "toml",
  "css", "scss", "html", "htm",
  "sh", "py", "rb", "go", "rs", "swift", "kt", "java", "c", "cpp", "h",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif",
  "env", "conf", "ini", "gitignore",
  "sql", "xml",
];

const EXT_PATTERN = FILE_EXTENSIONS.join("|");
const EXT_TAIL_RE = new RegExp(`\\.(?:${EXT_PATTERN})(?:$|[?#])`, "i");

// Known absolute-path prefixes — anything outside these is treated as a
// slug/logical identifier (e.g. `/deck/talkie/frames`) unless it ends in
// a known file extension. This avoids false-positives on prose paths.
const KNOWN_ABS_PREFIX = /^(?:\/Users\/|\/home\/|\/Volumes\/|\/var\/|\/etc\/|\/opt\/|\/tmp\/|\/private\/|\/mnt\/|\/Applications\/|\/usr\/|\/Library\/)/u;

const RAW_PATH_RE =
  /(?:^|[\s(\[`'"])((?:~\/|\.\/|\.\.\/|\/)[A-Za-z0-9._/\-]+|[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)+)/g;

export type PathMatch = {
  /** Index in the source string where the matched path token starts. */
  start: number;
  /** Index just past the end of the matched path token. */
  end: number;
  /** The matched path string. */
  path: string;
};

/** Does this token look like a real filesystem path (vs a slug/route)? */
function isFilesystemPath(token: string): boolean {
  // Home-relative or workspace-relative — always treat as a path.
  if (token.startsWith("~/") || token.startsWith("./") || token.startsWith("../")) {
    return true;
  }
  // Absolute path: must either start with a known FS prefix or end in a real ext.
  if (token.startsWith("/")) {
    return KNOWN_ABS_PREFIX.test(token) || EXT_TAIL_RE.test(token);
  }
  // Relative-looking token (e.g. `packages/web/foo.ts`): require an extension
  // and at least one path separator (already required by the regex).
  return EXT_TAIL_RE.test(token);
}

/** Find all filepath-like tokens in the given text. Non-overlapping matches. */
export function findPathMatches(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  const re = new RegExp(RAW_PATH_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const captured = m[1];
    if (!captured) continue;
    const path = captured.replace(/[.,;:!?]+$/u, "");
    if (!path || !isFilesystemPath(path)) continue;
    const captureOffset = m[0].lastIndexOf(captured);
    if (captureOffset < 0) continue;
    const start = m.index + captureOffset;
    out.push({ start, end: start + path.length, path });
  }
  return out;
}

/** Crude check: does this path look like an image? */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|avif)(?:$|[?#])/iu.test(path);
}

/** Crude check: does this path look like a directory (trailing slash or no extension)? */
export function isDirectoryLikePath(path: string): boolean {
  if (path.endsWith("/")) return true;
  const last = path.split("/").pop() ?? "";
  return !last.includes(".") && !path.startsWith("./") && !path.startsWith("../");
}

/** Tiny inline icon for the path token. */
function PathIcon({ kind }: { kind: "file" | "image" | "dir" }) {
  if (kind === "dir") {
    return (
      <svg
        className="s-path-token-icon"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M2 5a1 1 0 0 1 1-1h3.5l1.5 1.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
      </svg>
    );
  }
  if (kind === "image") {
    return (
      <svg
        className="s-path-token-icon"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <circle cx="6" cy="7" r="1" />
        <path d="m3 12 3.5-3 2.5 2 3-2.5L14 11" />
      </svg>
    );
  }
  return (
    <svg
      className="s-path-token-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

/** Clickable path token — opens the file preview overlay. */
export function PathToken({ path }: { path: string }) {
  const { openFilePreview } = useScout();
  const kind: "file" | "image" | "dir" = isImagePath(path)
    ? "image"
    : isDirectoryLikePath(path)
      ? "dir"
      : "file";
  return (
    <button
      type="button"
      className="s-path-token"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openFilePreview(path);
      }}
      title={`Open ${path}`}
    >
      <PathIcon kind={kind} />
      {path}
    </button>
  );
}
