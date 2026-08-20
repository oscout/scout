import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type PlanDocumentSource =
  | "claude"
  | "codex"
  | "openscout"
  | "workspace"
  | "unknown";

export type PlanDocumentKind =
  | "claude_plan"
  | "codex_plan"
  | "openscout_plan"
  | "markdown_plan";

export type PlanDocumentStatus =
  | "draft"
  | "active"
  | "blocked"
  | "completed"
  | "archived"
  | "unknown";

export type PlanDocumentStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "unknown";

export type PlanDocumentStep = {
  id: string;
  order: number;
  text: string;
  status: PlanDocumentStepStatus;
  rawMarker: string | null;
};

export type PlanDocument = {
  id: string;
  title: string;
  summary: string | null;
  source: PlanDocumentSource;
  documentKind: PlanDocumentKind;
  status: PlanDocumentStatus;
  confidence: "native" | "explicit" | "inferred";
  path: string;
  workspacePath: string | null;
  workspaceName: string | null;
  agentId: string | null;
  agentName: string | null;
  tags: string[];
  body: string;
  rawText: string;
  steps: PlanDocumentStep[];
  createdAt: number;
  updatedAt: number;
  provenance: {
    root: string;
    rootKind: "workspace" | "home";
    relativePath: string;
  };
};

export type PlanDocumentsResponse = {
  generatedAt: number;
  roots: Array<{
    path: string;
    kind: "workspace" | "home";
    label: string;
  }>;
  documents: PlanDocument[];
  totals: {
    documents: number;
    claude: number;
    codex: number;
    openscout: number;
    workspace: number;
  };
};

export type PlanDocumentWorkspace = {
  agentId?: string | null;
  agentName?: string | null;
  cwd?: string | null;
  project?: string | null;
  projectRoot?: string | null;
};

const HOME = homedir();
const PLAN_SUBDIRECTORIES = [
  "plans",
  ".openscout/plans",
  ".claude/plans",
  ".codex/plans",
  "docs/plans",
] as const;
const HOME_PLAN_ROOTS = [
  ".claude/plans",
  ".codex/plans",
  ".openscout/plans",
] as const;
const MAX_FILES_PER_ROOT = 300;
const MAX_DOCUMENT_BYTES = 1024 * 1024;

type CandidateRoot = {
  root: string;
  kind: "workspace" | "home";
  label: string;
  agentId: string | null;
  agentName: string | null;
  workspacePath: string | null;
};

type Frontmatter = {
  attributes: Record<string, string>;
  body: string;
};

function compactPath(value: string): string {
  return value.startsWith(HOME) ? `~${value.slice(HOME.length)}` : value;
}

function normalizeWorkspacePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return HOME;
  const expanded = trimmed.startsWith("~/") ? resolve(HOME, trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

function workspaceName(path: string): string {
  const leaf = basename(path);
  return leaf || path;
}

function addCandidateRoot(
  roots: Map<string, CandidateRoot>,
  input: CandidateRoot,
): void {
  roots.set(input.root, input);
}

function buildCandidateRoots(
  currentDirectory: string,
  workspaces: PlanDocumentWorkspace[],
  includeHome: boolean,
): CandidateRoot[] {
  const roots = new Map<string, CandidateRoot>();
  const current = normalizeWorkspacePath(currentDirectory);
  if (current) {
    addCandidateRoot(roots, {
      root: current,
      kind: "workspace",
      label: workspaceName(current),
      agentId: null,
      agentName: null,
      workspacePath: current,
    });
  }

  for (const workspace of workspaces) {
    const root = normalizeWorkspacePath(workspace.projectRoot) ?? normalizeWorkspacePath(workspace.cwd);
    if (!root) continue;
    addCandidateRoot(roots, {
      root,
      kind: "workspace",
      label: workspace.project?.trim() || workspaceName(root),
      agentId: workspace.agentId ?? null,
      agentName: workspace.agentName ?? null,
      workspacePath: root,
    });
  }

  if (includeHome) {
    for (const subdir of HOME_PLAN_ROOTS) {
      const root = resolve(HOME, subdir);
      addCandidateRoot(roots, {
        root,
        kind: "home",
        label: subdir.replace(/\/plans$/, ""),
        agentId: null,
        agentName: null,
        workspacePath: null,
      });
    }
  }

  return [...roots.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function walkMarkdownFiles(directory: string, remaining = { count: MAX_FILES_PER_ROOT }): Promise<string[]> {
  if (remaining.count <= 0) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }

  const files: string[] = [];
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (remaining.count <= 0) break;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      files.push(...await walkMarkdownFiles(fullPath, remaining));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
      files.push(fullPath);
      remaining.count -= 1;
    }
  }

  return files;
}

async function discoverPlanFiles(root: CandidateRoot): Promise<string[]> {
  if (root.kind === "home") {
    return walkMarkdownFiles(root.root);
  }

  const fromPlanDirs = (
    await Promise.all(PLAN_SUBDIRECTORIES.map((subdir) => walkMarkdownFiles(join(root.root, subdir))))
  ).flat();

  let directPlanFiles: string[] = [];
  try {
    const entries = await readdir(root.root, { withFileTypes: true });
    directPlanFiles = entries
      .filter((entry) => entry.isFile() && /\.plan\.md$/i.test(entry.name))
      .map((entry) => join(root.root, entry.name));
  } catch {
    directPlanFiles = [];
  }

  return [...new Set([...fromPlanDirs, ...directPlanFiles])];
}

function parseFrontmatter(source: string): Frontmatter {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized.trim() };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { attributes: {}, body: normalized.trim() };
  }

  const rawAttributes = normalized.slice(4, end).trim();
  const body = normalized.slice(end + 5).trim();
  const attributes: Record<string, string> = {};
  for (const line of rawAttributes.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    attributes[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return { attributes, body };
}

function titleFromSlug(slug: string): string {
  return slug
    .replace(/\.plan$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function extractTitle(attributes: Record<string, string>, body: string, filePath: string): string {
  if (attributes.title) return attributes.title;
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return titleFromSlug(basename(filePath, ".md"));
}

function extractSummary(attributes: Record<string, string>, body: string): string | null {
  if (attributes.summary) return attributes.summary;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("#")
      || trimmed.startsWith("- ")
      || trimmed.startsWith("* ")
      || trimmed.startsWith(">")
      || /^\d+\.\s/.test(trimmed)
    ) {
      continue;
    }
    return trimmed;
  }
  return null;
}

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function markerStatus(marker: string): PlanDocumentStepStatus {
  switch (marker.trim().toLowerCase()) {
    case "x":
      return "completed";
    case "~":
    case ".":
    case ">":
      return "in_progress";
    case "!":
      return "blocked";
    case "":
    case " ":
      return "pending";
    default:
      return "unknown";
  }
}

function extractSteps(body: string, documentId: string): PlanDocumentStep[] {
  const steps: PlanDocumentStep[] = [];
  let order = 0;
  for (const line of body.split("\n")) {
    const checkbox = line.match(/^\s*[-*]\s+\[([^\]])\]\s+(.+)$/);
    if (checkbox) {
      const text = checkbox[2].trim();
      steps.push({
        id: `${documentId}:step:${order}`,
        order,
        text,
        status: markerStatus(checkbox[1]),
        rawMarker: checkbox[1],
      });
      order += 1;
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      steps.push({
        id: `${documentId}:step:${order}`,
        order,
        text: ordered[1].trim(),
        status: "unknown",
        rawMarker: null,
      });
      order += 1;
    }
  }
  return steps;
}

function normalizeStatus(value: string | undefined): PlanDocumentStatus | null {
  switch (value?.trim().toLowerCase()) {
    case "draft":
      return "draft";
    case "active":
    case "in-progress":
    case "in_progress":
    case "running":
      return "active";
    case "blocked":
    case "stuck":
      return "blocked";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "archived":
    case "paused":
      return "archived";
    default:
      return null;
  }
}

function inferStatus(steps: PlanDocumentStep[]): PlanDocumentStatus {
  if (steps.length === 0) return "unknown";
  if (steps.some((step) => step.status === "blocked")) return "blocked";
  if (steps.some((step) => step.status === "in_progress")) return "active";
  if (steps.every((step) => step.status === "completed")) return "completed";
  if (steps.some((step) => step.status === "completed")) return "active";
  return "draft";
}

function sourceFromPath(filePath: string): PlanDocumentSource {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.claude/plans/")) return "claude";
  if (normalized.includes("/.codex/plans/")) return "codex";
  if (normalized.includes("/.openscout/plans/")) return "openscout";
  if (normalized.includes("/plans/") || /\.plan\.md$/i.test(normalized)) return "workspace";
  return "unknown";
}

function kindForSource(source: PlanDocumentSource): PlanDocumentKind {
  switch (source) {
    case "claude":
      return "claude_plan";
    case "codex":
      return "codex_plan";
    case "openscout":
      return "openscout_plan";
    default:
      return "markdown_plan";
  }
}

function timestampFromAttribute(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function idForPlan(root: CandidateRoot, filePath: string): string {
  const hash = createHash("sha256")
    .update(root.root)
    .update("\0")
    .update(filePath)
    .digest("hex")
    .slice(0, 16);
  return `plan-doc:${hash}`;
}

async function readPlanDocument(root: CandidateRoot, filePath: string): Promise<PlanDocument | null> {
  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats || !fileStats.isFile() || fileStats.size > MAX_DOCUMENT_BYTES) {
    return null;
  }

  const rawText = await readFile(filePath, "utf8").catch(() => null);
  if (rawText === null) return null;

  const id = idForPlan(root, filePath);
  const { attributes, body } = parseFrontmatter(rawText);
  const steps = extractSteps(body, id);
  const updatedAt = timestampFromAttribute(attributes.updated, fileStats.mtimeMs);
  const createdAt = timestampFromAttribute(attributes.created, fileStats.birthtimeMs || updatedAt);
  const source = sourceFromPath(filePath);
  const status = normalizeStatus(attributes.status) ?? inferStatus(steps);
  const relativePath = root.kind === "workspace"
    ? relative(root.root, filePath)
    : relative(HOME, filePath);

  return {
    id,
    title: extractTitle(attributes, body, filePath),
    summary: extractSummary(attributes, body),
    source,
    documentKind: kindForSource(source),
    status,
    confidence: source === "claude" || source === "codex" ? "native" : "explicit",
    path: compactPath(filePath),
    workspacePath: root.workspacePath ? compactPath(root.workspacePath) : null,
    workspaceName: root.kind === "workspace" ? root.label : null,
    agentId: attributes.agentid ?? attributes["agent-id"] ?? root.agentId,
    agentName: attributes.agent ?? root.agentName,
    tags: parseTags(attributes.tags),
    body,
    rawText,
    steps,
    createdAt,
    updatedAt,
    provenance: {
      root: compactPath(root.root),
      rootKind: root.kind,
      relativePath,
    },
  };
}

export async function indexPlanDocuments(input: {
  currentDirectory: string;
  workspaces?: PlanDocumentWorkspace[];
  includeHome?: boolean;
}): Promise<PlanDocumentsResponse> {
  const generatedAt = Date.now();
  const roots = buildCandidateRoots(input.currentDirectory, input.workspaces ?? [], input.includeHome ?? true);
  const seenFiles = new Set<string>();
  const documents: PlanDocument[] = [];

  for (const root of roots) {
    const files = await discoverPlanFiles(root);
    for (const file of files) {
      const resolved = resolve(file);
      if (seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);
      const document = await readPlanDocument(root, resolved);
      if (document) documents.push(document);
    }
  }

  documents.sort((left, right) => (
    right.updatedAt - left.updatedAt
    || left.title.localeCompare(right.title)
  ));

  return {
    generatedAt,
    roots: roots.map((root) => ({
      path: compactPath(root.root),
      kind: root.kind,
      label: root.label,
    })),
    documents,
    totals: {
      documents: documents.length,
      claude: documents.filter((doc) => doc.source === "claude").length,
      codex: documents.filter((doc) => doc.source === "codex").length,
      openscout: documents.filter((doc) => doc.source === "openscout").length,
      workspace: documents.filter((doc) => doc.source === "workspace").length,
    },
  };
}
