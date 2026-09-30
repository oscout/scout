// What a work item touched: the materials inventory GET /api/work/:id serves
// (as `inventory`) and GET /api/work/:id/inventory returns, plus one
// material's content.

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

/** Branch and in-flight changes to one material, added together. */
export function workMaterialDiffTotal(stat: WorkMaterialDiffStat): WorkMaterialDiffPart {
  return {
    additions: (stat.branch?.additions ?? 0) + (stat.inflight?.additions ?? 0),
    deletions: (stat.branch?.deletions ?? 0) + (stat.inflight?.deletions ?? 0),
  };
}

/** "+12 -3" for one material's combined diff. */
export function formatWorkMaterialDiff(stat: WorkMaterialDiffStat): string {
  const { additions, deletions } = workMaterialDiffTotal(stat);
  return `+${additions} -${deletions}`;
}
