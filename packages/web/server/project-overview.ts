import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PROJECT_AGENT_INSTRUCTION_CANDIDATES } from "@openscout/runtime";
import { collectTrustedRoots, resolveTrustedPath } from "./file-preview.ts";

export type ProjectArtifactKind = "instructions" | "docs" | "config" | "package";

export type ProjectArtifactFacet = {
  relativePath: string;
  absolutePath: string;
  kind: ProjectArtifactKind;
  exists: boolean;
  excerpt: string | null;
};

export type ProjectPackageFacet = {
  name: string | null;
  version: string | null;
  description: string | null;
};

export type ProjectOverviewPayload = {
  root: string;
  title: string;
  artifacts: ProjectArtifactFacet[];
  package: ProjectPackageFacet | null;
  projectConfigPath: string | null;
  projectConfigExists: boolean;
};

const DOC_ARTIFACTS = ["README.md", "llms.txt", "llms-full.txt", "DEV_INSTRUCTIONS.md", "install.md"] as const;

const CONFIG_ARTIFACTS = [".openscout/project.json", ".openscout/relay.json"] as const;

const EXCERPT_MAX_CHARS = 520;
const EXCERPT_MAX_LINES = 12;

function excerptFromText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/u).slice(0, EXCERPT_MAX_LINES);
  let text = lines.join("\n");
  const truncatedByLines = trimmed.split(/\r?\n/u).length > lines.length;
  if (text.length > EXCERPT_MAX_CHARS) {
    text = `${text.slice(0, EXCERPT_MAX_CHARS).trimEnd()}…`;
  } else if (truncatedByLines || trimmed.length > text.length) {
    text = `${text}…`;
  }
  return text;
}

async function readArtifactExcerpt(absolutePath: string, relativePath: string): Promise<string | null> {
  try {
    const raw = await readFile(absolutePath, "utf8");
    if (relativePath.endsWith(".json")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return excerptFromText(JSON.stringify(parsed, null, 2));
      } catch {
        return excerptFromText(raw);
      }
    }
    return excerptFromText(raw);
  } catch {
    return null;
  }
}

function artifactKind(relativePath: string): ProjectArtifactKind {
  if (relativePath === "package.json") return "package";
  if (relativePath.endsWith("project.json") || relativePath.endsWith("relay.json")) return "config";
  if ((PROJECT_AGENT_INSTRUCTION_CANDIDATES as readonly string[]).includes(relativePath)) {
    return "instructions";
  }
  if (relativePath === "CODEX.md" || relativePath === "CLAUDE.md") return "instructions";
  if (relativePath.endsWith(".md")) {
    const upper = relativePath.toUpperCase();
    if (upper.includes("AGENT") || upper.includes("CLAUDE") || upper.includes("CODEX")) {
      return "instructions";
    }
    return "docs";
  }
  return "docs";
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function buildArtifactList(projectRoot: string): string[] {
  return uniquePaths([
    ...PROJECT_AGENT_INSTRUCTION_CANDIDATES,
    ...DOC_ARTIFACTS,
    ...CONFIG_ARTIFACTS,
    "package.json",
    "CODEX.md",
    "CLAUDE.md",
  ]);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageFacet(packagePath: string): Promise<ProjectPackageFacet | null> {
  try {
    const raw = await readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
    };
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      description: typeof parsed.description === "string" ? parsed.description.trim() || null : null,
    };
  } catch {
    return null;
  }
}

export async function buildProjectOverview(input: {
  projectRoot: string;
  currentDirectory: string;
}): Promise<{ ok: true; payload: ProjectOverviewPayload } | { ok: false; status: number; error: string }> {
  const roots = collectTrustedRoots({ currentDirectory: input.currentDirectory });
  const resolved = resolveTrustedPath({ requestedPath: input.projectRoot, roots });
  if (!resolved.ok) {
    return { ok: false, status: resolved.status as number, error: resolved.error };
  }

  const root = resolved.realPath;
  const relativeArtifacts = buildArtifactList(root);
  const artifacts: ProjectArtifactFacet[] = [];

  for (const relativePath of relativeArtifacts) {
    const absolutePath = join(root, relativePath);
    const exists = await pathExists(absolutePath);
    artifacts.push({
      relativePath,
      absolutePath,
      kind: artifactKind(relativePath),
      exists,
      excerpt: exists ? await readArtifactExcerpt(absolutePath, relativePath) : null,
    });
  }

  const projectConfigPath = join(root, ".openscout", "project.json");
  const projectConfigExists = await pathExists(projectConfigPath);
  const packagePath = join(root, "package.json");
  const packageFacet = (await pathExists(packagePath)) ? await readPackageFacet(packagePath) : null;

  return {
    ok: true,
    payload: {
      root,
      title: basename(root),
      artifacts: artifacts.filter((row) => row.exists),
      package: packageFacet,
      projectConfigPath: projectConfigExists ? projectConfigPath : null,
      projectConfigExists,
    },
  };
}