import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_HINT_MARKERS = [
  ".git",
  ".openscout/project.json",
  "package.json",
  "AGENTS.md",
  "CLAUDE.md",
  "CODEX.md",
  ".claude",
  ".codex",
] as const;

/**
 * Best-effort decode of Claude Code's ~/.claude/projects slug (path slashes → hyphens).
 * Wrong when any single path segment contained `-` at session time (same limitation as Claude's encoding).
 * Always confirm with stat on the decoded path.
 */
export function decodeClaudeProjectsSlug(name: string): string | null {
  if (!name || name === "." || name === "..") {
    return null;
  }
  if (!name.startsWith("-")) {
    return null;
  }
  const tail = name.slice(1);
  if (!tail) {
    return null;
  }
  return `/${tail.replace(/-/g, "/")}`;
}

export function encodeClaudeProjectsSlug(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return `-${normalized.replace(/^\//, "").replace(/\//g, "-")}`;
}

async function resolveExistingDirectoryHint(pathLike: string): Promise<string | null> {
  const absolutePath = resolve(pathLike);
  try {
    const info = await stat(absolutePath);
    if (info.isDirectory()) {
      return absolutePath;
    }
    if (info.isFile()) {
      return dirname(absolutePath);
    }
  } catch {
    return null;
  }
  return null;
}

async function pathExists(pathLike: string): Promise<boolean> {
  try {
    await stat(pathLike);
    return true;
  } catch {
    return false;
  }
}

async function findLikelyProjectRoot(absolutePath: string): Promise<string> {
  let current = resolve(absolutePath);
  let lastCandidate: string | null = null;

  while (true) {
    for (const marker of PROJECT_HINT_MARKERS) {
      if (await pathExists(join(current, marker))) {
        lastCandidate = current;
        if (marker === ".git" || marker === ".openscout/project.json") {
          return current;
        }
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return lastCandidate ?? absolutePath;
    }
    current = parent;
  }
}

async function appendPathHint(pathLike: string, roots: Set<string>): Promise<void> {
  const existingDirectory = await resolveExistingDirectoryHint(pathLike);
  if (!existingDirectory) {
    return;
  }
  roots.add(await findLikelyProjectRoot(existingDirectory));
}

function cursorWorkspaceStoragePath(home: string): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      return join(appData, "Cursor", "User", "workspaceStorage");
    }
    return join(home, "AppData", "Roaming", "Cursor", "User", "workspaceStorage");
  }
  return join(home, ".config", "Cursor", "User", "workspaceStorage");
}

function collectPathLikeStrings(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 4 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (value.startsWith("/") && value.length > 1 && !value.includes("\n") && !value.includes("\0")) {
      out.add(value);
    }
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathLikeStrings(item, out, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectPathLikeStrings(v, out, depth + 1);
    }
  }
}

async function appendCodexHistoryPaths(home: string, roots: Set<string>): Promise<void> {
  const candidates = [join(home, ".codex", "history.jsonl"), join(home, ".openai-codex", "history.jsonl")];
  const maxLines = 2500;
  const maxBytes = 4 * 1024 * 1024;

  for (const filePath of candidates) {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > maxBytes) {
      continue;
    }

    let body: string;
    try {
      body = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    let lineCount = 0;
    for (const line of body.split("\n")) {
      if (lineCount++ > maxLines) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const extracted = new Set<string>();
        collectPathLikeStrings(parsed, extracted, 0);
        for (const p of extracted) {
          await appendPathHint(p, roots);
        }
      } catch {
        continue;
      }
    }
  }
}

async function appendCursorWorkspacePaths(home: string, roots: Set<string>): Promise<void> {
  const base = cursorWorkspaceStoragePath(home);
  let ids: string[] = [];
  try {
    ids = await readdir(base);
  } catch {
    return;
  }

  for (const id of ids) {
    const workspaceJsonPath = join(base, id, "workspace.json");
    let raw: string;
    try {
      raw = await readFile(workspaceJsonPath, "utf8");
    } catch {
      continue;
    }

    let doc: { folder?: string; workspace?: string };
    try {
      doc = JSON.parse(raw) as { folder?: string; workspace?: string };
    } catch {
      continue;
    }

    if (typeof doc.folder === "string" && doc.folder.startsWith("file://")) {
      try {
        const folderPath = fileURLToPath(doc.folder);
        await appendPathHint(folderPath, roots);
      } catch {
        /* ignore */
      }
    }

    if (typeof doc.workspace === "string" && doc.workspace.startsWith("file://")) {
      try {
        const wsFile = fileURLToPath(doc.workspace);
        if (!wsFile.endsWith(".code-workspace")) {
          continue;
        }
        let wsStat;
        try {
          wsStat = await stat(wsFile);
        } catch {
          continue;
        }
        if (!wsStat.isFile()) {
          continue;
        }
        const wsRaw = await readFile(wsFile, "utf8");
        const wsDoc = JSON.parse(wsRaw) as { folders?: Array<{ path?: string }> };
        const wsDir = dirname(wsFile);
        for (const f of wsDoc.folders ?? []) {
          if (typeof f.path !== "string" || !f.path) {
            continue;
          }
          const resolvedPath = resolve(wsDir, f.path);
          await appendPathHint(resolvedPath, roots);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

async function appendClaudeProjectSlugs(home: string, roots: Set<string>): Promise<void> {
  const projectsDir = join(home, ".claude", "projects");
  let names: string[] = [];
  try {
    names = await readdir(projectsDir, { withFileTypes: false });
  } catch {
    return;
  }

  for (const name of names) {
    const decoded = decodeClaudeProjectsSlug(name);
    if (!decoded) {
      continue;
    }
    await appendPathHint(decoded, roots);
  }
}

async function appendClaudeSessionPaths(home: string, roots: Set<string>): Promise<void> {
  const projectsDir = join(home, ".claude", "projects");
  const maxProjectDirectories = 200;
  const maxSessionFiles = 400;
  const maxLinesPerFile = 400;
  const maxBytesPerFile = 2 * 1024 * 1024;

  let projectNames: string[] = [];
  try {
    projectNames = (await readdir(projectsDir, { withFileTypes: false })).slice(0, maxProjectDirectories);
  } catch {
    return;
  }

  let seenFiles = 0;
  for (const projectName of projectNames) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(projectsDir, projectName), { withFileTypes: false });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (seenFiles >= maxSessionFiles) {
        return;
      }
      if (!entry.endsWith(".jsonl")) {
        continue;
      }

      const sessionPath = join(projectsDir, projectName, entry);
      let info;
      try {
        info = await stat(sessionPath);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size > maxBytesPerFile) {
        continue;
      }
      seenFiles += 1;

      let body: string;
      try {
        body = await readFile(sessionPath, "utf8");
      } catch {
        continue;
      }

      let lineCount = 0;
      for (const line of body.split("\n")) {
        if (lineCount++ >= maxLinesPerFile) {
          break;
        }
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as unknown;
          const extracted = new Set<string>();
          collectPathLikeStrings(parsed, extracted, 0);
          for (const p of extracted) {
            await appendPathHint(p, roots);
          }
        } catch {
          continue;
        }
      }
    }
  }
}

export type CollectUserProjectHintsOptions = {
  /** Override home (tests). Defaults to `os.homedir()`. */
  home?: string;
};

/**
 * Extra project roots inferred from user-level agent/IDE data (best effort, lossy).
 * Always filter with stat — never trust decoded paths alone.
 */
export async function collectUserLevelProjectRootHints(
  options: CollectUserProjectHintsOptions = {},
): Promise<string[]> {
  const home = options.home ?? homedir();
  const roots = new Set<string>();

  try {
    await appendClaudeProjectSlugs(home, roots);
  } catch {
    /* best-effort */
  }
  try {
    await appendClaudeSessionPaths(home, roots);
  } catch {
    /* best-effort */
  }
  try {
    await appendCursorWorkspacePaths(home, roots);
  } catch {
    /* best-effort: Cursor storage can be unreadable or corrupt */
  }
  try {
    await appendCodexHistoryPaths(home, roots);
  } catch {
    /* best-effort */
  }

  return Array.from(roots).sort();
}
