import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectTrustedRoots, resolveTrustedPath } from "./file-preview.ts";

const EXCERPT_MAX_CHARS = 520;
const EXCERPT_MAX_LINES = 12;

const SKIPPED_NAMES = new Set(["skills", "prompts", "node_modules", ".git"]);

export type AgentDefinitionFile = {
  name: string;
  relativePath: string;
  absolutePath: string;
  excerpt: string | null;
};

export type AgentDefinitionFolder = {
  slug: string;
  folderPath: string;
  files: AgentDefinitionFile[];
};

export type AgentDefinitionsPayload = {
  projectRoot: string;
  agentsRoot: string;
  agentsRootExists: boolean;
  selectedSlug: string | null;
  folders: AgentDefinitionFolder[];
};

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

async function readFileExcerpt(absolutePath: string, relativePath: string): Promise<string | null> {
  try {
    const raw = await readFile(absolutePath, "utf8");
    if (relativePath.endsWith(".json") || relativePath.endsWith(".yaml") || relativePath.endsWith(".yml")) {
      return excerptFromText(raw);
    }
    return excerptFromText(raw);
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function agentSlugFromHandle(handle: string | null | undefined, name: string): string | null {
  const trimmed = handle?.replace(/^@+/, "").trim();
  if (trimmed) return trimmed.toLowerCase();
  const fromName = name.trim().toLowerCase().replace(/\s+/g, "-");
  return fromName || null;
}

async function listFolderFiles(
  folderPath: string,
  slug: string,
): Promise<AgentDefinitionFile[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const files: AgentDefinitionFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = join(folderPath, entry.name);
    const relativePath = `${slug}/${entry.name}`;
    files.push({
      name: entry.name,
      relativePath,
      absolutePath,
      excerpt: await readFileExcerpt(absolutePath, relativePath),
    });
  }
  return files.sort((a, b) => {
    const rank = (name: string) => {
      if (name === "AGENT.md") return 0;
      if (name.startsWith("agent.config")) return 1;
      if (name === "README.md") return 2;
      return 3;
    };
    const delta = rank(a.name) - rank(b.name);
    return delta !== 0 ? delta : a.name.localeCompare(b.name);
  });
}

export async function buildAgentDefinitions(input: {
  projectRoot: string;
  agentHandle?: string | null;
  agentName?: string;
  currentDirectory: string;
}): Promise<{ ok: true; payload: AgentDefinitionsPayload } | { ok: false; status: number; error: string }> {
  const roots = collectTrustedRoots({ currentDirectory: input.currentDirectory });
  const resolved = resolveTrustedPath({ requestedPath: input.projectRoot, roots });
  if (!resolved.ok) {
    return { ok: false, status: resolved.status as number, error: resolved.error };
  }

  const projectRoot = resolved.realPath;
  const agentsRoot = join(projectRoot, ".agents");
  const agentsRootExists = await pathExists(agentsRoot);
  const selectedSlug = agentSlugFromHandle(input.agentHandle, input.agentName ?? "");
  const folders: AgentDefinitionFolder[] = [];

  if (agentsRootExists) {
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_NAMES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const folderPath = join(agentsRoot, entry.name);
      const files = await listFolderFiles(folderPath, entry.name);
      if (files.length === 0) continue;
      folders.push({
        slug: entry.name,
        folderPath,
        files,
      });
    }
    folders.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  return {
    ok: true,
    payload: {
      projectRoot,
      agentsRoot,
      agentsRootExists,
      selectedSlug,
      folders,
    },
  };
}

export async function resolveAgentProjectRoot(input: {
  agentId: string;
  getAgent: (agentId: string) => Promise<{ projectRoot: string | null; cwd: string | null; handle: string | null; name: string } | null>;
  currentDirectory: string;
}): Promise<{ ok: true; root: string; handle: string | null; name: string } | { ok: false; status: number; error: string }> {
  const agent = await input.getAgent(input.agentId);
  if (!agent) {
    return { ok: false, status: 404, error: "agent not found" };
  }
  const candidate = agent.projectRoot ?? agent.cwd;
  if (!candidate) {
    return { ok: false, status: 404, error: "agent has no project root" };
  }
  const roots = collectTrustedRoots({ currentDirectory: input.currentDirectory });
  const resolved = resolveTrustedPath({ requestedPath: candidate, roots });
  if (!resolved.ok) {
    return { ok: false, status: resolved.status as number, error: resolved.error };
  }
  return { ok: true, root: resolved.realPath, handle: agent.handle, name: agent.name };
}