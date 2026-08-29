/* scout://{path} deep links for the code browser / file viewer.

   Accepted forms:
     scout://openscout
     scout://openscout/packages/web/client/foo.ts
     scout://openscout/foo.ts?wt=comms&line=12&endLine=20
     scout:///Users/art/dev/openscout/foo.ts
     scout:///Users/art/dev/openscout/foo.ts?line=12
     scout://file/Users/art/dev/openscout/foo.ts   (explicit absolute)
     scout://code/openscout/foo.ts                 (legacy host)

   Hosts reserved for other Scout surfaces are never treated as project slugs.
*/

/** Hosts that own other scout:// surfaces — not project slugs. */
export const SCOUT_RESERVED_HOSTS = new Set([
  "hud",
  "tail",
  "terminal",
  "services",
  "pair",
  "osn-auth",
  "notification",
  "code",
  "file",
]);

export type ScoutCodeDeepLink = {
  /** Absolute filesystem root when known (absolute form). */
  root?: string;
  /** Absolute file path when known (absolute form). */
  file?: string;
  /** Project slug (project-relative form). */
  project?: string;
  /** Path relative to the project/worktree root. */
  path?: string;
  /** Worktree name / branch slug for non-primary trees. */
  wt?: string;
  line?: number;
  endLine?: number;
};

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveLine(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function decodePathSegments(segments: string[]): string {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join("/");
}

function queryFields(params: URLSearchParams): Pick<ScoutCodeDeepLink, "wt" | "line" | "endLine"> {
  const line = parsePositiveLine(params.get("line"));
  const rawEnd = parsePositiveLine(params.get("endLine"));
  const endLine = line && rawEnd && rawEnd >= line ? rawEnd : undefined;
  return {
    ...(clean(params.get("wt")) ? { wt: clean(params.get("wt")) } : {}),
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
  };
}

/**
 * Parse a scout:// deep link or a bare absolute path.
 * Returns null when the input is not a code deep link (other scout hosts, garbage).
 */
export function parseScoutCodeDeepLink(raw: string): ScoutCodeDeepLink | null {
  const input = raw.trim();
  if (!input) return null;

  // Bare absolute / home path — convenient paste target in the picker.
  if (input.startsWith("/") || input.startsWith("~/")) {
    const withoutScheme = input.replace(/^~/, ""); // expand happens at open time on host
    // Keep ~ form as absolute root/file token; callers expand tilde if needed.
    const absolute = input.startsWith("~") ? input : withoutScheme;
    // Directory-looking tokens still open as root/file; the surface decides.
    return { root: absolute, file: absolute };
  }

  if (!/^scout:/i.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== "scout:") return null;

  const host = (url.hostname || url.host || "").toLowerCase();
  // URL.pathname always starts with / when present.
  const pathParts = url.pathname
    .split("/")
    .filter((part) => part.length > 0);
  const query = queryFields(url.searchParams);

  // Absolute: scout:///Users/...  (empty host) or scout://file/Users/...
  if (!host || host === "file") {
    const absoluteParts = host === "file" ? pathParts : pathParts;
    if (absoluteParts.length === 0) return null;
    const absolute = `/${decodePathSegments(absoluteParts)}`;
    // Also accept root/file query overrides.
    const root = clean(url.searchParams.get("root"));
    const file = clean(url.searchParams.get("file"));
    return {
      root: root ?? absolute,
      file: file ?? absolute,
      ...query,
    };
  }

  // Legacy: scout://code/<project>/[path...]
  if (host === "code") {
    if (pathParts.length === 0) {
      // scout://code?root=&file=
      const root = clean(url.searchParams.get("root"));
      const file = clean(url.searchParams.get("file"));
      const project = clean(url.searchParams.get("project"));
      const path = clean(url.searchParams.get("path"));
      if (!root && !file && !project) return { ...query };
      return {
        ...(root ? { root } : {}),
        ...(file ? { file } : {}),
        ...(project ? { project } : {}),
        ...(path ? { path } : {}),
        ...query,
      };
    }
    const project = decodePathSegments([pathParts[0]!]);
    const rel = pathParts.length > 1 ? decodePathSegments(pathParts.slice(1)) : undefined;
    return {
      project,
      ...(rel ? { path: rel } : {}),
      ...query,
    };
  }

  // Other reserved hosts are not code deep links.
  if (SCOUT_RESERVED_HOSTS.has(host)) return null;

  // Primary form: scout://{project}/[path...]
  const project = decodeURIComponent(host);
  const rel = pathParts.length > 0 ? decodePathSegments(pathParts) : undefined;
  return {
    project,
    ...(rel ? { path: rel } : {}),
    ...query,
  };
}

/** Build a scout:// deep link from a code selection. Prefer project form. */
export function formatScoutCodeDeepLink(link: ScoutCodeDeepLink): string {
  const params = new URLSearchParams();
  if (link.wt) params.set("wt", link.wt);
  if (link.line && link.line > 0) params.set("line", String(link.line));
  if (link.line && link.endLine && link.endLine >= link.line) {
    params.set("endLine", String(link.endLine));
  }
  const search = params.toString();
  const suffix = search ? `?${search}` : "";

  if (link.project) {
    const body = link.path
      ? `${encodeURIComponent(link.project)}/${encodePathSegments(link.path)}`
      : encodeURIComponent(link.project);
    return `scout://${body}${suffix}`;
  }

  const absolute = link.file ?? link.root;
  if (absolute) {
    // scout:///abs/path — empty host, absolute path.
    const normalized = absolute.startsWith("/") ? absolute : `/${absolute}`;
    return `scout://${normalized}${suffix}`;
  }

  return `scout://code${suffix}`;
}

/**
 * Map an absolute path onto the best known worktree root.
 * Longest-prefix wins so nested worktrees beat the main root.
 */
export function matchRootForAbsolutePath(
  absolutePath: string,
  roots: readonly string[],
): { root: string; file: string | null } | null {
  const path = absolutePath.trim();
  if (!path) return null;
  let best: string | null = null;
  for (const root of roots) {
    if (path === root || path.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  if (!best) return null;
  return {
    root: best,
    file: path === best ? null : path,
  };
}

/** True when the free-text query looks like a deep link / absolute path paste. */
export function looksLikeCodeDeepLink(raw: string): boolean {
  const input = raw.trim();
  if (!input) return false;
  if (input.startsWith("/") || input.startsWith("~/")) return true;
  if (/^scout:/i.test(input)) return true;
  return false;
}
