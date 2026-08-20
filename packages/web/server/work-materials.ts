import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  queryAgents,
  queryRuns,
  querySessionById,
  type MobileSessionSummary,
  type WebAgent,
  type WebAgentRun,
  type WebWorkDetail,
} from "./db-queries.ts";
import {
  loadAgentObservePayload,
  loadSessionRefObservePayload,
  type AgentObservePayload,
  type ObserveData,
  type ObserveEvent,
  type ObserveFile,
  type SessionRefObservePayload,
} from "./core/observe/service.ts";
import {
  classifyMaterialPath,
  isMaterialExcluded,
  materialExcludePatterns,
  resolveMaterialClassifier,
  type MaterialClassifier,
} from "./material-heuristics.ts";
import {
  gitDiffNumstat,
  gitMergeBase,
  gitRevParse,
  gitStatusPorcelain,
} from "@openscout/runtime/system-probes";

export type WorkInventoryMode =
  | "isolated-git-worktree"
  | "shared-git-repo"
  | "trace-only"
  | "explicit-artifacts";

export type WorkInventorySource = "broker" | "git" | "trace" | "mixed";
export type WorkInventoryConfidence = "high" | "medium" | "low";

export type WorkMaterialKind =
  | "plan"
  | "spec"
  | "doc"
  | "code"
  | "test"
  | "config"
  | "asset"
  | "other";

export type WorkMaterialStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "observed";

export type WorkMaterialEvidence =
  | "broker"
  | "git-status"
  | "git-diff"
  | "trace-read"
  | "trace-write"
  | "trace-edit"
  | "trace-command"
  | "inferred-path";

export type WorkMaterialDiffPart = { additions: number; deletions: number };

export type WorkMaterialDiffStat = {
  branch: WorkMaterialDiffPart | null;
  inflight: WorkMaterialDiffPart | null;
};

export type WorkInventoryAgentRef = {
  id: string;
  name: string | null;
  role: "owner" | "next-move" | "runner" | "session" | "observed-helper";
  harness: string | null;
  cwd: string | null;
  projectRoot: string | null;
  sessionId: string | null;
  source: "broker" | "run" | "session" | "observe-topology";
};

export type WorkInventorySessionRef = {
  id: string;
  conversationId: string | null;
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  cwd: string | null;
  source: "conversation" | "run-trace" | "observe";
};

export type WorkMaterial = {
  id: string;
  kind: WorkMaterialKind;
  path: string;
  status: WorkMaterialStatus;
  agentId: string | null;
  sessionId: string | null;
  worktreeRoot: string | null;
  scopePath: string | null;
  baseRef: string | null;
  headRef: string | null;
  diffStat: WorkMaterialDiffStat | null;
  evidence: WorkMaterialEvidence[];
  confidence: WorkInventoryConfidence;
};

export type WorkMaterialsInventory = {
  workId: string;
  generatedAt: number;
  mode: WorkInventoryMode;
  source: WorkInventorySource;
  confidence: WorkInventoryConfidence;
  agents: WorkInventoryAgentRef[];
  sessions: WorkInventorySessionRef[];
  materials: WorkMaterial[];
  totals: {
    materials: number;
    plans: number;
    specs: number;
    docs: number;
    code: number;
    tests: number;
    config: number;
    assets: number;
    agents: number;
    sessions: number;
  };
  limitations: string[];
};

export type WorkMaterialContent = {
  workId: string;
  materialId: string;
  path: string;
  title: string;
  uri: string;
  mediaType: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  generatedAt: number;
};

export type WorkMaterialContentResult =
  | { ok: true; content: WorkMaterialContent }
  | { ok: false; status: number; error: string };

export type WorkMaterialRawResult =
  | { ok: true; realPath: string; mediaType: string; sizeBytes: number }
  | { ok: false; status: number; error: string };

type GitFileStatus = {
  path: string;
  status: WorkMaterialStatus;
  staged: boolean;
  unstaged: boolean;
};

type GitContext = {
  root: string;
  scopePath: string | null;
  headRef: string | null;
  branch: string | null;
  baseRef: string | null;
  isolatedWorktree: boolean;
  files: GitFileStatus[];
  diffStats: Map<string, WorkMaterialDiffStat>;
  classifier: MaterialClassifier;
};

type MaterialDraft = Omit<WorkMaterial, "id" | "kind" | "evidence" | "confidence"> & {
  evidence: Set<WorkMaterialEvidence>;
  touchedByTrace: boolean;
  touchedByGit: boolean;
};

type InventoryBuildState = {
  work: WebWorkDetail;
  agentsById: Map<string, WebAgent>;
  agentRefs: Map<string, WorkInventoryAgentRef>;
  sessionRefs: Map<string, WorkInventorySessionRef>;
  materials: Map<string, MaterialDraft>;
  gitContexts: GitContext[];
  classifierByRoot: Map<string, MaterialClassifier>;
  limitations: string[];
};

const HOME = homedir();
const MAX_AGENT_OBSERVE_PAYLOADS = 8;
const MAX_SESSION_REF_PAYLOADS = 8;
const MAX_GIT_CONTEXTS = 12;
const MAX_MATERIALS = 80;
const MAX_MATERIAL_VIEW_BYTES = 512 * 1024;

function expandHome(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "~") {
    return HOME;
  }
  if (trimmed.startsWith("~/")) {
    return resolve(HOME, trimmed.slice(2));
  }
  return trimmed;
}

function normalizeExistingPath(value: string | null | undefined): string | null {
  const expanded = expandHome(value);
  if (!expanded) {
    return null;
  }
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
  if (!existsSync(absolute)) {
    return null;
  }
  try {
    const stat = statSync(absolute);
    return stat.isDirectory() ? absolute : dirname(absolute);
  } catch {
    return null;
  }
}

function compactHome(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.startsWith(HOME) ? `~${value.slice(HOME.length)}` : value;
}

function expandMaterialRoot(value: string | null | undefined): string | null {
  const expanded = expandHome(value);
  return expanded ? resolve(expanded) : null;
}

function trustedMaterialRoot(material: WorkMaterial): string | null {
  return expandMaterialRoot(material.worktreeRoot);
}

function materialAbsolutePath(material: WorkMaterial, root: string): string {
  if (isAbsolute(material.path)) {
    return resolve(material.path);
  }
  return resolve(root, material.path);
}

function materialMediaType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "text/markdown";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "application/json";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return "text/css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".sh")) return "text/x-shellscript";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "text/yaml";
  if (lower.endsWith(".toml")) return "text/toml";
  return "text/plain";
}

function looksTextual(path: string, buffer: Buffer): boolean {
  const lower = path.toLowerCase();
  if (/\.(md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|py|swift|kt|java|go|rs|css|scss|html|sql|sh|xml|log)$/u.test(lower)) {
    return true;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

function gitPathspecArgs(scopeArg: string, classifier: MaterialClassifier): string[] {
  return [
    scopeArg,
    ...materialExcludePatterns(classifier).map((pattern) => `:(exclude)${pattern}`),
  ];
}

function pathInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathDisplayForRoot(path: string, root: string | null): string {
  if (root && isAbsolute(path) && pathInsideRoot(path, root)) {
    return relative(root, path) || ".";
  }
  return path;
}

function materialKey(path: string, root: string | null): string {
  return `${root ?? "trace"}::${path}`;
}

function statusRank(status: WorkMaterialStatus): number {
  switch (status) {
    case "deleted":
      return 6;
    case "renamed":
      return 5;
    case "added":
      return 4;
    case "modified":
      return 3;
    case "untracked":
      return 2;
    case "observed":
      return 1;
  }
}

function chooseStatus(left: WorkMaterialStatus, right: WorkMaterialStatus): WorkMaterialStatus {
  return statusRank(right) > statusRank(left) ? right : left;
}

function inferStatusFromGitCode(code: string): WorkMaterialStatus {
  if (code === "??") {
    return "untracked";
  }
  if (code.includes("R")) {
    return "renamed";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  if (code.includes("A")) {
    return "added";
  }
  return "modified";
}

function parseGitStatus(raw: string | null): GitFileStatus[] {
  if (!raw) {
    return [];
  }
  const records = raw.split("\0").filter((entry) => entry.length > 0);
  const files: GitFileStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index]!;
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) {
      continue;
    }
    const staged = code[0] !== " " && code[0] !== "?";
    const unstaged = code[1] !== " " && code[1] !== "?";
    files.push({
      path: filePath,
      status: inferStatusFromGitCode(code),
      staged,
      unstaged,
    });
    if (code.includes("R") || code.includes("C")) {
      index += 1;
    }
  }
  return files;
}

function parseDiffStats(raw: string | null): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  if (!raw) {
    return stats;
  }
  for (const line of raw.split(/\r?\n/u)) {
    const [rawAdd, rawDel, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t").trim();
    if (!rawAdd || !rawDel || !filePath) {
      continue;
    }
    const additions = Number.parseInt(rawAdd, 10);
    const deletions = Number.parseInt(rawDel, 10);
    stats.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return stats;
}

function combineDiffStats(
  branchStats: Map<string, WorkMaterialDiffPart>,
  inflightStats: Map<string, WorkMaterialDiffPart>,
): Map<string, WorkMaterialDiffStat> {
  const stats = new Map<string, WorkMaterialDiffStat>();
  for (const path of new Set([...branchStats.keys(), ...inflightStats.keys()])) {
    stats.set(path, {
      branch: branchStats.get(path) ?? null,
      inflight: inflightStats.get(path) ?? null,
    });
  }
  return stats;
}

function mergeMaterialDiffStat(
  existing: WorkMaterialDiffStat | null | undefined,
  next: WorkMaterialDiffStat | null | undefined,
): WorkMaterialDiffStat | null {
  if (!existing) {
    return next ?? null;
  }
  if (!next) {
    return existing;
  }
  return {
    branch: existing.branch ?? next.branch,
    inflight: existing.inflight ?? next.inflight,
  };
}

async function resolveTrunkRef(root: string, branch: string | null): Promise<string | null> {
  if (branch === "main" || branch === "master") {
    return null;
  }
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    const resolved = await gitRevParse({ repoRoot: root, kind: "verifyCommit", ref });
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function resolveGitContext(candidatePath: string): Promise<GitContext | null> {
  const root = await gitRevParse({ repoRoot: candidatePath, kind: "showToplevel" });
  if (!root) {
    return null;
  }
  const absoluteRoot = resolve(root);
  const scopedPath = pathInsideRoot(candidatePath, absoluteRoot)
    ? relative(absoluteRoot, candidatePath) || null
    : null;
  const gitDir = await gitRevParse({ repoRoot: absoluteRoot, kind: "gitDir" });
  const scopeArg = scopedPath ?? ".";
  const classifier = resolveMaterialClassifier(absoluteRoot);
  const pathspecArgs = gitPathspecArgs(scopeArg, classifier);
  const status = parseGitStatus(
    await gitStatusPorcelain({
      repoRoot: absoluteRoot,
      version: "v1",
      z: true,
      paths: pathspecArgs,
    }),
  );
  const headRef = await gitRevParse({ repoRoot: absoluteRoot, kind: "shortHead" });
  const branch = headRef ? await gitRevParse({ repoRoot: absoluteRoot, kind: "abbrevRefHead" }) : null;
  const trunkRef = headRef ? await resolveTrunkRef(absoluteRoot, branch) : null;
  const mergeBase = trunkRef
    ? await gitMergeBase({ repoRoot: absoluteRoot, baseRef: trunkRef, compareRef: "HEAD" })
    : null;
  const branchStats = mergeBase
    ? parseDiffStats(
      await gitDiffNumstat({
        repoRoot: absoluteRoot,
        selector: { kind: "range", notation: "ellipsis", baseRef: mergeBase, compareRef: "HEAD" },
        paths: pathspecArgs,
      }),
    )
    : new Map<string, WorkMaterialDiffPart>();
  const inflightStats = headRef
    ? parseDiffStats(await gitDiffNumstat({
      repoRoot: absoluteRoot,
      selector: { kind: "fromRef", ref: "HEAD" },
      paths: pathspecArgs,
    }))
    : new Map<string, WorkMaterialDiffPart>();
  const diffStats = combineDiffStats(branchStats, inflightStats);

  return {
    root: absoluteRoot,
    scopePath: scopedPath,
    headRef,
    branch,
    baseRef: mergeBase ? mergeBase.slice(0, 12) : null,
    isolatedWorktree: Boolean(gitDir?.includes("/.git/worktrees/")),
    files: status,
    diffStats,
    classifier,
  };
}

function addAgentRef(
  state: InventoryBuildState,
  agentId: string | null | undefined,
  role: WorkInventoryAgentRef["role"],
  source: WorkInventoryAgentRef["source"],
  fallbackName?: string | null,
): void {
  if (!agentId) {
    return;
  }
  const agent = state.agentsById.get(agentId);
  const existing = state.agentRefs.get(agentId);
  if (existing) {
    if (existing.role !== "owner" && role === "owner") {
      existing.role = role;
    }
    return;
  }
  state.agentRefs.set(agentId, {
    id: agentId,
    name: agent?.name ?? fallbackName ?? null,
    role,
    harness: agent?.harness ?? null,
    cwd: agent?.cwd ?? null,
    projectRoot: agent?.projectRoot ?? null,
    sessionId: agent?.harnessSessionId ?? null,
    source,
  });
}

function addSessionRef(
  state: InventoryBuildState,
  ref: WorkInventorySessionRef,
): void {
  if (!ref.id.trim()) {
    return;
  }
  const existing = state.sessionRefs.get(ref.id);
  if (existing) {
    existing.cwd ??= ref.cwd;
    existing.agentId ??= ref.agentId;
    existing.agentName ??= ref.agentName;
    existing.harness ??= ref.harness;
    return;
  }
  state.sessionRefs.set(ref.id, ref);
}

function materialRootForPath(path: string, gitContexts: GitContext[]): string | null {
  if (!isAbsolute(path)) {
    return null;
  }
  const matching = gitContexts
    .filter((context) => pathInsideRoot(path, context.root))
    .sort((left, right) => right.root.length - left.root.length);
  return matching[0]?.root ?? null;
}

function classifierForRoot(state: InventoryBuildState, root: string | null): MaterialClassifier {
  const key = root ?? "global";
  let classifier = state.classifierByRoot.get(key);
  if (!classifier) {
    classifier = resolveMaterialClassifier(root);
    state.classifierByRoot.set(key, classifier);
  }
  return classifier;
}

function upsertMaterial(
  state: InventoryBuildState,
  input: {
    path: string;
    status: WorkMaterialStatus;
    agentId?: string | null;
    sessionId?: string | null;
    worktreeRoot?: string | null;
    scopePath?: string | null;
    baseRef?: string | null;
    headRef?: string | null;
    diffStat?: WorkMaterialDiffStat | null;
    evidence: WorkMaterialEvidence[];
    touchedByGit?: boolean;
    touchedByTrace?: boolean;
  },
): void {
  const rawPath = input.path.trim();
  if (!rawPath) {
    return;
  }
  const root = input.worktreeRoot ?? materialRootForPath(rawPath, state.gitContexts);
  const displayPath = pathDisplayForRoot(rawPath, root);
  if (isMaterialExcluded(displayPath, classifierForRoot(state, root))) {
    return;
  }
  const key = materialKey(displayPath, root);
  const existing = state.materials.get(key);
  if (!existing) {
    state.materials.set(key, {
      path: displayPath,
      status: input.status,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      worktreeRoot: root ? compactHome(root) : null,
      scopePath: input.scopePath ?? null,
      baseRef: input.baseRef ?? null,
      headRef: input.headRef ?? null,
      diffStat: input.diffStat ?? null,
      evidence: new Set(input.evidence),
      touchedByGit: Boolean(input.touchedByGit),
      touchedByTrace: Boolean(input.touchedByTrace),
    });
    return;
  }
  existing.status = chooseStatus(existing.status, input.status);
  existing.agentId ??= input.agentId ?? null;
  existing.sessionId ??= input.sessionId ?? null;
  existing.worktreeRoot ??= root ? compactHome(root) : null;
  existing.scopePath ??= input.scopePath ?? null;
  existing.baseRef ??= input.baseRef ?? null;
  existing.headRef ??= input.headRef ?? null;
  existing.diffStat = mergeMaterialDiffStat(existing.diffStat, input.diffStat);
  existing.touchedByGit ||= Boolean(input.touchedByGit);
  existing.touchedByTrace ||= Boolean(input.touchedByTrace);
  for (const evidence of input.evidence) {
    existing.evidence.add(evidence);
  }
}

function statusFromObserveFile(file: ObserveFile): WorkMaterialStatus {
  switch (file.state) {
    case "created":
      return "added";
    case "modified":
      return "modified";
    default:
      return "observed";
  }
}

function evidenceFromObserveFile(file: ObserveFile): WorkMaterialEvidence {
  switch (file.state) {
    case "created":
      return "trace-write";
    case "modified":
      return "trace-edit";
    default:
      return "trace-read";
  }
}

const PATH_MENTION_PATTERN =
  /(?:^|[\s"'`])((?:~\/|\/|\.{1,2}\/)?[A-Za-z0-9_@./-]+\.(?:md|mdx|txt|ts|tsx|js|jsx|json|jsonc|yaml|yml|toml|lock|py|swift|kt|java|go|rs|css|scss|html|sql|sh|png|jpg|jpeg|gif|svg|pdf|docx))(?:$|[\s"'`,):;])/gu;

function extractPathMentions(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const paths: string[] = [];
  for (const match of value.matchAll(PATH_MENTION_PATTERN)) {
    const path = match[1]?.trim();
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

function addTracePathMentions(
  state: InventoryBuildState,
  event: ObserveEvent,
  agentId: string | null,
  sessionId: string | null,
): void {
  const values = [
    event.text,
    event.arg,
    event.detail,
    ...(event.stream ?? []),
  ];
  for (const value of values) {
    for (const path of extractPathMentions(value)) {
      upsertMaterial(state, {
        path,
        status: "observed",
        agentId,
        sessionId,
        evidence: [event.tool === "bash" ? "trace-command" : "inferred-path"],
        touchedByTrace: true,
      });
    }
  }
}

async function addObservePayload(
  state: InventoryBuildState,
  payload: AgentObservePayload | SessionRefObservePayload,
): Promise<void> {
  const agentId = "agentId" in payload ? payload.agentId : null;
  const sessionId = payload.sessionId ?? payload.data.metadata?.session?.externalSessionId ?? null;
  const sessionMeta = payload.data.metadata?.session;
  if (sessionId) {
    addSessionRef(state, {
      id: sessionId,
      conversationId: null,
      agentId,
      agentName: agentId ? state.agentsById.get(agentId)?.name ?? null : null,
      harness: sessionMeta?.adapterType ?? null,
      cwd: sessionMeta?.cwd ?? null,
      source: "observe",
    });
  }

  if (sessionMeta?.cwd) {
    const normalized = normalizeExistingPath(sessionMeta.cwd);
    const context = normalized ? await resolveGitContext(normalized) : null;
    if (context && !state.gitContexts.some((existing) =>
      existing.root === context.root && existing.scopePath === context.scopePath
    )) {
      state.gitContexts.push(context);
      addGitMaterials(state, context, agentId);
    }
  }

  for (const file of payload.data.files) {
    upsertMaterial(state, {
      path: file.path,
      status: statusFromObserveFile(file),
      agentId,
      sessionId,
      evidence: [evidenceFromObserveFile(file)],
      touchedByTrace: true,
    });
  }

  for (const event of payload.data.events) {
    addTracePathMentions(state, event, agentId, sessionId);
  }

  const topology = (payload.data.metadata as (
    ObserveData["metadata"] & {
      topology?: {
        agents?: Array<{
          id?: string;
          name?: string;
          type?: string;
          cwd?: string;
          externalSessionId?: string;
        }>;
      };
    }
  ) | undefined)?.topology;
  for (const observed of topology?.agents ?? []) {
    if (!observed.id) {
      continue;
    }
    const id = `observed:${observed.id}`;
    if (!state.agentRefs.has(id)) {
      state.agentRefs.set(id, {
        id,
        name: observed.name ?? observed.id,
        role: "observed-helper",
        harness: observed.type ?? null,
        cwd: observed.cwd ?? null,
        projectRoot: null,
        sessionId: observed.externalSessionId ?? null,
        source: "observe-topology",
      });
    }
  }
}

function materialSortRank(material: WorkMaterial): number {
  switch (material.kind) {
    case "plan":
      return 0;
    case "spec":
      return 1;
    case "doc":
      return 2;
    case "test":
      return 3;
    case "code":
      return 4;
    case "config":
      return 5;
    case "asset":
      return 6;
    case "other":
      return 7;
  }
}

function materialConfidence(
  material: MaterialDraft,
  gitContexts: GitContext[],
): WorkInventoryConfidence {
  if (material.evidence.has("broker")) {
    return "high";
  }
  if (material.touchedByGit && material.touchedByTrace) {
    return "high";
  }
  if (material.touchedByGit) {
    const root = expandHome(material.worktreeRoot);
    const context = root ? gitContexts.find((candidate) => candidate.root === root) : null;
    return context?.isolatedWorktree ? "high" : "medium";
  }
  if (
    material.evidence.has("trace-write")
    || material.evidence.has("trace-edit")
    || material.evidence.has("trace-read")
  ) {
    return "medium";
  }
  return "low";
}

function finalizeMaterials(state: InventoryBuildState): WorkMaterial[] {
  return [...state.materials.values()]
    .map((draft) => {
      const evidence = [...draft.evidence].sort();
      const root = expandHome(draft.worktreeRoot);
      const classifier = classifierForRoot(state, root);
      return {
        ...draft,
        id: materialKey(draft.path, draft.worktreeRoot),
        kind: classifyMaterialPath(draft.path, classifier) ?? "other",
        evidence,
        confidence: materialConfidence(draft, state.gitContexts),
      };
    })
    .sort((left, right) =>
      materialSortRank(left) - materialSortRank(right)
      || statusRank(right.status) - statusRank(left.status)
      || left.path.localeCompare(right.path)
    )
    .slice(0, MAX_MATERIALS);
}

function inventorySource(hasGit: boolean, hasTrace: boolean, hasBroker: boolean): WorkInventorySource {
  const count = [hasGit, hasTrace, hasBroker].filter(Boolean).length;
  if (count > 1) {
    return "mixed";
  }
  if (hasGit) {
    return "git";
  }
  if (hasTrace) {
    return "trace";
  }
  return "broker";
}

function inventoryMode(state: InventoryBuildState, materials: WorkMaterial[]): WorkInventoryMode {
  if (materials.some((material) => material.evidence.includes("broker"))) {
    return "explicit-artifacts";
  }
  if (state.gitContexts.some((context) => context.isolatedWorktree && context.files.length > 0)) {
    return "isolated-git-worktree";
  }
  if (state.gitContexts.some((context) => context.files.length > 0)) {
    return "shared-git-repo";
  }
  return "trace-only";
}

function inventoryConfidence(mode: WorkInventoryMode, materials: WorkMaterial[]): WorkInventoryConfidence {
  if (mode === "explicit-artifacts" || mode === "isolated-git-worktree") {
    return "high";
  }
  if (mode === "shared-git-repo") {
    return materials.some((material) => material.confidence === "high") ? "medium" : "medium";
  }
  return materials.some((material) => material.confidence === "medium") ? "medium" : "low";
}

function addGitMaterials(state: InventoryBuildState, context: GitContext, agentId: string | null): void {
  const filesByPath = new Map(context.files.map((file) => [file.path, file]));
  const materialPaths = new Set([...filesByPath.keys(), ...context.diffStats.keys()]);
  for (const path of materialPaths) {
    const file = filesByPath.get(path);
    const hasDiffStat = context.diffStats.has(path);
    upsertMaterial(state, {
      path,
      status: file?.status ?? "modified",
      agentId,
      sessionId: null,
      worktreeRoot: context.root,
      scopePath: context.scopePath,
      baseRef: context.baseRef,
      headRef: context.headRef,
      diffStat: context.diffStats.get(path) ?? null,
      evidence: [
        ...(file ? (["git-status"] as WorkMaterialEvidence[]) : []),
        ...(hasDiffStat ? (["git-diff"] as WorkMaterialEvidence[]) : []),
      ],
      touchedByGit: true,
    });
  }
}

async function addGitContextsForAgents(state: InventoryBuildState): Promise<void> {
  const candidateByKey = new Map<string, { path: string; agentId: string | null }>();
  for (const ref of state.agentRefs.values()) {
    for (const candidate of [ref.cwd, ref.projectRoot]) {
      const normalized = normalizeExistingPath(candidate);
      if (normalized) {
        candidateByKey.set(`${normalized}::${ref.id}`, { path: normalized, agentId: ref.id });
      }
    }
  }
  for (const ref of state.sessionRefs.values()) {
    const normalized = normalizeExistingPath(ref.cwd);
    if (normalized) {
      candidateByKey.set(`${normalized}::${ref.agentId ?? "session"}`, {
        path: normalized,
        agentId: ref.agentId,
      });
    }
  }

  for (const candidate of candidateByKey.values()) {
    if (state.gitContexts.length >= MAX_GIT_CONTEXTS) {
      state.limitations.push("Git inventory was capped to keep the work page responsive.");
      break;
    }
    const context = await resolveGitContext(candidate.path);
    if (!context) {
      continue;
    }
    if (!state.gitContexts.some((existing) =>
      existing.root === context.root && existing.scopePath === context.scopePath
    )) {
      state.gitContexts.push(context);
      state.classifierByRoot.set(context.root, context.classifier);
      addGitMaterials(state, context, candidate.agentId);
    }
  }
}

function addRunEvidence(state: InventoryBuildState, runs: WebAgentRun[]): void {
  for (const run of runs) {
    addAgentRef(state, run.agentId, "runner", "run", run.agentName);
    for (const sessionId of run.traceSessionIds ?? []) {
      addSessionRef(state, {
        id: sessionId,
        conversationId: run.conversationId ?? null,
        agentId: run.agentId,
        agentName: run.agentName ?? null,
        harness: run.harness ?? null,
        cwd: null,
        source: "run-trace",
      });
    }
  }
}

function addConversationSession(state: InventoryBuildState, session: MobileSessionSummary | null): void {
  if (!session) {
    return;
  }
  if (session.agentId) {
    addAgentRef(state, session.agentId, "session", "session", session.agentName);
  }
  addSessionRef(state, {
    id: session.harnessSessionId ?? session.id,
    conversationId: session.id,
    agentId: session.agentId,
    agentName: session.agentName,
    harness: session.harness,
    cwd: session.workspaceRoot,
    source: "conversation",
  });
}

async function addObserveEvidence(state: InventoryBuildState): Promise<void> {
  const agentIds = [...state.agentRefs.values()]
    .filter((ref) => !ref.id.startsWith("observed:"))
    .map((ref) => ref.id)
    .slice(0, MAX_AGENT_OBSERVE_PAYLOADS);
  const sessionIds = [...state.sessionRefs.keys()].slice(0, MAX_SESSION_REF_PAYLOADS);

  const seenObserveKeys = new Set<string>();
  const payloads: Array<AgentObservePayload | SessionRefObservePayload> = [];
  for (const agentId of agentIds) {
    const payload = await loadAgentObservePayload(agentId).catch(() => null);
    if (!payload || payload.source === "unavailable") {
      continue;
    }
    const key = `agent:${agentId}:${payload.sessionId ?? payload.historyPath ?? "unknown"}`;
    if (!seenObserveKeys.has(key)) {
      seenObserveKeys.add(key);
      payloads.push(payload);
    }
  }
  for (const sessionId of sessionIds) {
    const payload = await loadSessionRefObservePayload(sessionId).catch(() => null);
    if (!payload) {
      continue;
    }
    const key = `${payload.kind}:${payload.refId}:${payload.historyPath ?? "unknown"}`;
    if (!seenObserveKeys.has(key)) {
      seenObserveKeys.add(key);
      payloads.push(payload);
    }
  }

  for (const payload of payloads) {
    await addObservePayload(state, payload);
  }
}

function totals(
  materials: WorkMaterial[],
  agents: WorkInventoryAgentRef[],
  sessions: WorkInventorySessionRef[],
): WorkMaterialsInventory["totals"] {
  return {
    materials: materials.length,
    plans: materials.filter((material) => material.kind === "plan").length,
    specs: materials.filter((material) => material.kind === "spec").length,
    docs: materials.filter((material) => material.kind === "doc").length,
    code: materials.filter((material) => material.kind === "code").length,
    tests: materials.filter((material) => material.kind === "test").length,
    config: materials.filter((material) => material.kind === "config").length,
    assets: materials.filter((material) => material.kind === "asset").length,
    agents: agents.length,
    sessions: sessions.length,
  };
}

export async function buildWorkMaterialsInventory(
  work: WebWorkDetail,
): Promise<WorkMaterialsInventory> {
  const agentsById = new Map(queryAgents(200).map((agent) => [agent.id, agent]));
  const state: InventoryBuildState = {
    work,
    agentsById,
    agentRefs: new Map(),
    sessionRefs: new Map(),
    materials: new Map(),
    gitContexts: [],
    classifierByRoot: new Map(),
    limitations: [],
  };

  addAgentRef(state, work.ownerId, "owner", "broker", work.ownerName);
  addAgentRef(state, work.nextMoveOwnerId, "next-move", "broker", work.nextMoveOwnerName);
  for (const flight of work.activeFlights) {
    addAgentRef(state, flight.agentId, "runner", "run", flight.agentName);
  }

  const runs = queryRuns({ workId: work.id, active: false, limit: 100 });
  addRunEvidence(state, runs);
  addConversationSession(state, work.conversationId ? querySessionById(work.conversationId) : null);
  await addGitContextsForAgents(state);
  await addObserveEvidence(state);
  await addGitContextsForAgents(state);

  if (state.gitContexts.length === 0) {
    state.limitations.push("No related git repository was detected; inventory is trace-derived.");
  } else if (state.gitContexts.some((context) => !context.isolatedWorktree)) {
    state.limitations.push("Some git evidence comes from shared repos, so attribution may include unrelated local changes.");
  }

  const materials = finalizeMaterials(state);
  const agents = [...state.agentRefs.values()].sort((left, right) => left.id.localeCompare(right.id));
  const sessions = [...state.sessionRefs.values()].sort((left, right) => left.id.localeCompare(right.id));
  const hasGit = materials.some((material) => material.evidence.includes("git-status") || material.evidence.includes("git-diff"));
  const hasTrace = materials.some((material) =>
    material.evidence.some((evidence) => evidence.startsWith("trace-") || evidence === "inferred-path")
  );
  const hasBroker = materials.some((material) => material.evidence.includes("broker"));
  const mode = inventoryMode(state, materials);

  return {
    workId: work.id,
    generatedAt: Date.now(),
    mode,
    source: inventorySource(hasGit, hasTrace, hasBroker),
    confidence: inventoryConfidence(mode, materials),
    agents,
    sessions,
    materials,
    totals: totals(materials, agents, sessions),
    limitations: state.limitations,
  };
}

async function resolveTrustedMaterialPath(
  work: WebWorkDetail,
  materialId: string,
): Promise<
  | { ok: true; material: WorkMaterial; realPath: string }
  | { ok: false; status: number; error: string }
> {
  const trimmedId = materialId.trim();
  if (!trimmedId) {
    return { ok: false, status: 400, error: "materialId is required" };
  }

  const inventory = await buildWorkMaterialsInventory(work);
  const material = inventory.materials.find((candidate) => candidate.id === trimmedId);
  if (!material) {
    return { ok: false, status: 404, error: "material not found" };
  }
  if (material.status === "deleted") {
    return { ok: false, status: 410, error: "material was deleted" };
  }

  const root = trustedMaterialRoot(material);
  if (!root) {
    return { ok: false, status: 404, error: "material does not have a trusted local root" };
  }

  const absolutePath = materialAbsolutePath(material, root);
  try {
    const realPath = realpathSync(absolutePath);
    const realRoot = realpathSync(root);
    if (!pathInsideRoot(realPath, realRoot)) {
      return { ok: false, status: 403, error: "material path is outside its trusted root" };
    }
    const stat = statSync(realPath);
    if (!stat.isFile()) {
      return { ok: false, status: 415, error: "material is not a file" };
    }
    return { ok: true, material, realPath };
  } catch {
    return { ok: false, status: 404, error: "material could not be read" };
  }
}

export async function readWorkMaterialRaw(
  work: WebWorkDetail,
  materialId: string,
): Promise<WorkMaterialRawResult> {
  const resolved = await resolveTrustedMaterialPath(work, materialId);
  if (!resolved.ok) {
    return resolved;
  }
  try {
    const stat = statSync(resolved.realPath);
    return {
      ok: true,
      realPath: resolved.realPath,
      mediaType: materialMediaType(resolved.realPath),
      sizeBytes: stat.size,
    };
  } catch {
    return { ok: false, status: 404, error: "material could not be read" };
  }
}

export async function readWorkMaterialContent(
  work: WebWorkDetail,
  materialId: string,
): Promise<WorkMaterialContentResult> {
  const trimmedId = materialId.trim();
  if (!trimmedId) {
    return { ok: false, status: 400, error: "materialId is required" };
  }

  const inventory = await buildWorkMaterialsInventory(work);
  const material = inventory.materials.find((candidate) => candidate.id === trimmedId);
  if (!material) {
    return { ok: false, status: 404, error: "material not found" };
  }
  if (material.status === "deleted") {
    return { ok: false, status: 410, error: "material was deleted" };
  }

  const root = trustedMaterialRoot(material);
  if (!root) {
    return { ok: false, status: 404, error: "material does not have a trusted local root" };
  }

  const absolutePath = materialAbsolutePath(material, root);
  try {
    const realPath = realpathSync(absolutePath);
    const realRoot = realpathSync(root);
    if (!pathInsideRoot(realPath, realRoot)) {
      return { ok: false, status: 403, error: "material path is outside its trusted root" };
    }
    const stat = statSync(realPath);
    if (!stat.isFile()) {
      return { ok: false, status: 415, error: "material is not a file" };
    }

    const buffer = readFileSync(realPath);
    if (!looksTextual(realPath, buffer)) {
      return { ok: false, status: 415, error: "material is not a text document" };
    }
    const truncated = buffer.length > MAX_MATERIAL_VIEW_BYTES;
    const readable = truncated ? buffer.subarray(0, MAX_MATERIAL_VIEW_BYTES) : buffer;
    const title = material.path.split("/").pop() ?? material.path;
    return {
      ok: true,
      content: {
        workId: work.id,
        materialId: material.id,
        path: material.path,
        title,
        uri: realPath,
        mediaType: materialMediaType(realPath),
        content: readable.toString("utf8"),
        sizeBytes: buffer.length,
        truncated,
        generatedAt: Date.now(),
      },
    };
  } catch {
    return { ok: false, status: 404, error: "material could not be read" };
  }
}
