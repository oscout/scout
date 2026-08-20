export type ScoutbotEngineId = "native" | "mastra" | (string & {});

export type ScoutbotEngineCapability =
  | "deterministic"
  | "llm"
  | "external-runtime"
  | "streaming"
  | "memory"
  | "workflows"
  | "observability";

export type ScoutbotEngineCapabilities = {
  id: ScoutbotEngineId;
  displayName: string;
  summary: string;
  capabilities: ScoutbotEngineCapability[];
  canExecuteDurableWrites: false;
};

export type ScoutbotAllowedActionKind =
  | "open-route"
  | "open-file"
  | "review-worktree"
  | "ask-agent"
  | "create-checkback"
  | "notify";

export type ScoutbotSituationInput = {
  request: {
    id: string;
    prompt: string;
    createdAt: number;
  };
  generatedAt: number;
  currentDirectory: string;
  currentRoute?: Record<string, unknown> | null;
  broker?: {
    reachable: boolean;
    generatedAt?: number | null;
    counts?: Record<string, number>;
  } | null;
  attention?: ScoutbotAttentionSnapshot | null;
  worktrees?: ScoutbotWorktreeSignal[];
  recentWork?: ScoutbotRecentWorkSignal[];
  allowedActions: ScoutbotAllowedActionKind[];
  constraints: {
    enginesMayWrite: false;
    durableWritesRequireScoutBroker: true;
  };
};

export type ScoutbotAttentionSnapshot = {
  since: number;
  generatedAt: number;
  brokerReachable: boolean;
  projects: ScoutbotAttentionProjectSignal[];
};

export type ScoutbotAttentionProjectSignal = {
  projectRoot: string | null;
  projectName: string;
  status: "needs_attention" | "active" | string;
  score: number;
  reasons: string[];
  lastActivityAt: number | null;
  git?: ScoutbotGitSignal | null;
  evidence: ScoutbotAttentionEvidenceSignal[];
};

export type ScoutbotAttentionEvidenceSignal = {
  kind: string;
  severity: "interrupt" | "badge" | "info" | string;
  id?: string | null;
  state?: string | null;
  summary: string;
  at?: number | null;
  agentId?: string | null;
  invocationId?: string | null;
  flightId?: string | null;
  workId?: string | null;
  messageId?: string | null;
};

export type ScoutbotGitSignal = {
  projectRoot: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  hasChanges: boolean;
  lastCommitAt: number | null;
  shortStatus: string[];
};

export type ScoutbotWorktreeSignal = ScoutbotGitSignal & {
  id?: string;
  path?: string;
  projectName?: string;
};

export type ScoutbotRecentWorkSignal = {
  id: string;
  title: string;
  projectRoot: string | null;
  status: "completed" | "review" | "unlanded" | "landed" | "blocked" | "unknown" | string;
  summary?: string | null;
  completedAt?: number | null;
  landedAt?: number | null;
  source?: string | null;
  agentId?: string | null;
  references?: ScoutbotEvidenceRef[];
};

export type ScoutbotPerspectiveKind =
  | "worktree_hygiene"
  | "recent_unlanded"
  | "blocked_or_risky"
  | "next_focus";

export type ScoutbotEvidenceKind =
  | "attention"
  | "flight"
  | "git"
  | "message"
  | "recent_work"
  | "work_item"
  | "worktree";

export type ScoutbotEvidenceRef = {
  id: string;
  kind: ScoutbotEvidenceKind | (string & {});
  summary: string;
  projectRoot?: string | null;
  agentId?: string | null;
  recordId?: string | null;
  route?: Record<string, unknown>;
  observedAt?: number | null;
};

export type ScoutbotSituationPerspective = {
  id: string;
  kind: ScoutbotPerspectiveKind;
  title: string;
  summary: string;
  priority: number;
  evidenceIds: string[];
};

export type ScoutbotProposedAction = {
  id: string;
  kind: ScoutbotAllowedActionKind;
  label: string;
  rationale: string;
  execution: "proposed";
  requiresBrokerWrite: boolean;
  payload?: Record<string, unknown>;
  evidenceIds: string[];
};

export type ScoutbotSituationReport = {
  engineId: ScoutbotEngineId;
  generatedAt: number;
  headline: string;
  summary: string;
  perspectives: ScoutbotSituationPerspective[];
  evidence: ScoutbotEvidenceRef[];
  proposedActions: ScoutbotProposedAction[];
  missingData: string[];
  confidence: "low" | "medium" | "high";
};

export type ScoutbotEngine = {
  id: ScoutbotEngineId;
  displayName: string;
  describe: () => ScoutbotEngineCapabilities;
  run: (input: ScoutbotSituationInput) => Promise<ScoutbotSituationReport>;
};

export type ScoutbotEngineRun = {
  engineId: ScoutbotEngineId;
  displayName: string;
  elapsedMs: number;
  report: ScoutbotSituationReport | null;
  error: string | null;
};

export type ScoutbotEngineComparison = {
  requestId: string;
  generatedAt: number;
  runs: ScoutbotEngineRun[];
};

export type ScoutbotExternalRuntimeAdapter = {
  id: ScoutbotEngineId;
  displayName: string;
  describe?: () => Omit<ScoutbotEngineCapabilities, "id" | "displayName" | "canExecuteDurableWrites">;
  invoke: (input: ScoutbotSituationInput) => Promise<ScoutbotSituationReport>;
};

export function createNativeScoutbotEngine(): ScoutbotEngine {
  return {
    id: "native",
    displayName: "Scoutbot Native",
    describe: () => ({
      id: "native",
      displayName: "Scoutbot Native",
      summary: "Deterministic Scout-owned baseline over broker, attention, git, and recent-work signals.",
      capabilities: ["deterministic", "observability"],
      canExecuteDurableWrites: false,
    }),
    run: async (input) => buildNativeScoutbotSituationReport(input),
  };
}

export function createExternalScoutbotEngine(adapter: ScoutbotExternalRuntimeAdapter): ScoutbotEngine {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    describe: () => {
      const described = adapter.describe?.();
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        summary: described?.summary ?? "External Scoutbot engine adapter.",
        capabilities: described?.capabilities ?? ["external-runtime"],
        canExecuteDurableWrites: false,
      };
    },
    run: async (input) => normalizeEngineReport(adapter.id, await adapter.invoke(input)),
  };
}

export async function compareScoutbotEngines(
  input: ScoutbotSituationInput,
  engines: ScoutbotEngine[],
): Promise<ScoutbotEngineComparison> {
  const runs = await Promise.all(engines.map(async (engine): Promise<ScoutbotEngineRun> => {
    const startedAt = Date.now();
    try {
      return {
        engineId: engine.id,
        displayName: engine.displayName,
        elapsedMs: Date.now() - startedAt,
        report: normalizeEngineReport(engine.id, await engine.run(input)),
        error: null,
      };
    } catch (error) {
      return {
        engineId: engine.id,
        displayName: engine.displayName,
        elapsedMs: Date.now() - startedAt,
        report: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  return {
    requestId: input.request.id,
    generatedAt: Date.now(),
    runs,
  };
}

export function buildNativeScoutbotSituationReport(
  input: ScoutbotSituationInput,
): ScoutbotSituationReport {
  const evidence: ScoutbotEvidenceRef[] = [];
  const actions: ScoutbotProposedAction[] = [];
  const missingData: string[] = [];
  const perspectives: ScoutbotSituationPerspective[] = [];
  const addEvidence = createEvidenceCollector(evidence);

  const worktrees = collectWorktreeSignals(input);
  if (!input.attention) missingData.push("attention report");
  if (!input.worktrees) missingData.push("worktree inventory");
  if (!input.recentWork) missingData.push("recent completed work");
  if (!input.broker) missingData.push("broker snapshot summary");

  const riskyWorktrees = worktrees.filter(worktreeNeedsAttention);
  const worktreeEvidenceIds = riskyWorktrees.map((worktree) =>
    addEvidence({
      kind: "worktree",
      summary: worktreeSummary(worktree),
      projectRoot: worktree.projectRoot,
      recordId: worktree.id ?? worktree.projectRoot,
      observedAt: worktree.lastCommitAt,
    })
  );
  perspectives.push({
    id: "perspective.worktree_hygiene",
    kind: "worktree_hygiene",
    title: "Worktree hygiene",
    summary: worktrees.length === 0
      ? "No worktree inventory was provided."
      : `${riskyWorktrees.length} of ${worktrees.length} known worktrees need attention.`,
    priority: riskyWorktrees.length > 0 ? 80 : 20,
    evidenceIds: worktreeEvidenceIds,
  });

  const recentUnlanded = (input.recentWork ?? []).filter(isRecentUnlandedWork);
  const recentEvidenceIds = recentUnlanded.map((work) =>
    addEvidence({
      kind: "recent_work",
      summary: recentWorkSummary(work),
      projectRoot: work.projectRoot,
      agentId: work.agentId ?? null,
      recordId: work.id,
      observedAt: work.completedAt ?? work.landedAt ?? null,
    })
  );
  perspectives.push({
    id: "perspective.recent_unlanded",
    kind: "recent_unlanded",
    title: "Recently done but not landed",
    summary: recentUnlanded.length === 0
      ? "No recently completed unlanded work was provided."
      : `${recentUnlanded.length} completed item${recentUnlanded.length === 1 ? "" : "s"} still need review, landing, or closure.`,
    priority: recentUnlanded.length > 0 ? 90 : 10,
    evidenceIds: recentEvidenceIds,
  });

  const riskyAttention = collectRiskyAttention(input.attention);
  const riskyEvidenceIds = riskyAttention.map((item) =>
    addEvidence({
      kind: evidenceKindForAttention(item.evidence),
      summary: item.evidence.summary,
      projectRoot: item.project.projectRoot,
      agentId: item.evidence.agentId ?? null,
      recordId: item.evidence.id ?? item.evidence.flightId ?? item.evidence.workId ?? item.evidence.messageId ?? null,
      observedAt: item.evidence.at ?? item.project.lastActivityAt,
    })
  );
  perspectives.push({
    id: "perspective.blocked_or_risky",
    kind: "blocked_or_risky",
    title: "Blocked or risky work",
    summary: riskyAttention.length === 0
      ? "No blocking or risky attention evidence was provided."
      : `${riskyAttention.length} blocking or risky signal${riskyAttention.length === 1 ? "" : "s"} surfaced across Scout records.`,
    priority: riskyAttention.length > 0 ? 100 : 15,
    evidenceIds: riskyEvidenceIds,
  });

  const focus = chooseNativeFocus({
    recentUnlanded,
    riskyWorktrees,
    riskyAttention,
  });
  perspectives.push({
    id: "perspective.next_focus",
    kind: "next_focus",
    title: "Recommended next focus",
    summary: focus.summary,
    priority: focus.priority,
    evidenceIds: focus.evidenceIds.map((item) => addEvidence(item)),
  });

  const firstRecentEvidence = recentEvidenceIds[0];
  if (firstRecentEvidence && input.allowedActions.includes("review-worktree")) {
    actions.push({
      id: "action.review-recent-unlanded",
      kind: "review-worktree",
      label: "Review recently completed unlanded work",
      rationale: "Completed work that has not landed is the highest-value operator review target.",
      execution: "proposed",
      requiresBrokerWrite: false,
      evidenceIds: [firstRecentEvidence],
    });
  }

  const firstRiskEvidence = riskyEvidenceIds[0];
  if (firstRiskEvidence && input.allowedActions.includes("create-checkback")) {
    actions.push({
      id: "action.create-risk-checkback",
      kind: "create-checkback",
      label: "Create a Scout checkback for the top risk",
      rationale: "The engine can propose a durable follow-up, but the Scout broker must create it.",
      execution: "proposed",
      requiresBrokerWrite: true,
      evidenceIds: [firstRiskEvidence],
    });
  }

  const headline = headlineFor({
    recentUnlandedCount: recentUnlanded.length,
    riskyWorktreeCount: riskyWorktrees.length,
    riskyAttentionCount: riskyAttention.length,
  });

  return {
    engineId: "native",
    generatedAt: input.generatedAt,
    headline,
    summary: [
      perspectives.find((item) => item.kind === "recent_unlanded")?.summary,
      perspectives.find((item) => item.kind === "blocked_or_risky")?.summary,
      perspectives.find((item) => item.kind === "worktree_hygiene")?.summary,
    ].filter(Boolean).join(" "),
    perspectives: perspectives.sort((left, right) => right.priority - left.priority),
    evidence,
    proposedActions: actions,
    missingData,
    confidence: confidenceFor(input, missingData),
  };
}

function normalizeEngineReport(
  engineId: ScoutbotEngineId,
  report: ScoutbotSituationReport,
): ScoutbotSituationReport {
  return {
    ...report,
    engineId,
    proposedActions: report.proposedActions.map((action) => ({
      ...action,
      execution: "proposed",
      requiresBrokerWrite: Boolean(action.requiresBrokerWrite),
    })),
  };
}

function createEvidenceCollector(evidence: ScoutbotEvidenceRef[]): (item: Omit<ScoutbotEvidenceRef, "id"> & { id?: string }) => string {
  let next = 1;
  return (item) => {
    const id = item.id ?? `evidence.${next++}`;
    evidence.push({
      ...item,
      id,
      summary: compactText(item.summary, 220),
    });
    return id;
  };
}

function collectWorktreeSignals(input: ScoutbotSituationInput): ScoutbotWorktreeSignal[] {
  const seen = new Set<string>();
  const out: ScoutbotWorktreeSignal[] = [];
  const add = (worktree: ScoutbotWorktreeSignal | null | undefined) => {
    if (!worktree) return;
    const key = worktree.id ?? worktree.projectRoot;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(worktree);
  };

  for (const worktree of input.worktrees ?? []) add(worktree);
  for (const project of input.attention?.projects ?? []) {
    if (project.git) {
      add({
        ...project.git,
        id: `attention.git.${project.projectRoot ?? project.projectName}`,
        projectName: project.projectName,
      });
    }
  }

  return out;
}

function worktreeNeedsAttention(worktree: ScoutbotWorktreeSignal): boolean {
  return worktree.hasChanges
    || worktree.ahead > 0
    || worktree.behind > 0
    || worktree.changedFiles > 0
    || worktree.untrackedFiles > 0;
}

function worktreeSummary(worktree: ScoutbotWorktreeSignal): string {
  const parts = [
    worktree.projectName ?? worktree.projectRoot,
    worktree.branch ? `branch ${worktree.branch}` : null,
    worktree.changedFiles > 0 ? `${worktree.changedFiles} changed` : null,
    worktree.ahead > 0 ? `${worktree.ahead} ahead` : null,
    worktree.behind > 0 ? `${worktree.behind} behind` : null,
    worktree.untrackedFiles > 0 ? `${worktree.untrackedFiles} untracked` : null,
  ];
  return parts.filter(Boolean).join("; ");
}

function isRecentUnlandedWork(work: ScoutbotRecentWorkSignal): boolean {
  if (work.landedAt) return false;
  return work.status === "completed"
    || work.status === "review"
    || work.status === "unlanded"
    || work.status === "blocked";
}

function recentWorkSummary(work: ScoutbotRecentWorkSignal): string {
  const parts = [
    work.title,
    work.status,
    work.summary,
    work.source ? `source ${work.source}` : null,
  ];
  return parts.filter(Boolean).join("; ");
}

function collectRiskyAttention(attention: ScoutbotAttentionSnapshot | null | undefined): Array<{
  project: ScoutbotAttentionProjectSignal;
  evidence: ScoutbotAttentionEvidenceSignal;
}> {
  const out: Array<{
    project: ScoutbotAttentionProjectSignal;
    evidence: ScoutbotAttentionEvidenceSignal;
  }> = [];

  for (const project of attention?.projects ?? []) {
    for (const evidence of project.evidence) {
      if (isRiskyAttentionEvidence(project, evidence)) {
        out.push({ project, evidence });
      }
    }
  }

  return out;
}

function isRiskyAttentionEvidence(
  project: ScoutbotAttentionProjectSignal,
  evidence: ScoutbotAttentionEvidenceSignal,
): boolean {
  if (project.status === "needs_attention") return true;
  if (evidence.severity === "interrupt") return true;
  const state = evidence.state?.toLowerCase();
  if (state === "failed" || state === "cancelled" || state === "waiting" || state === "blocked") return true;
  return /\b(blocked|failed|failure|error|unable|waiting|dirty|uncommitted|not run|untested)\b/i.test(evidence.summary);
}

function evidenceKindForAttention(evidence: ScoutbotAttentionEvidenceSignal): ScoutbotEvidenceKind {
  if (evidence.kind === "flight") return "flight";
  if (evidence.kind === "message") return "message";
  if (evidence.kind === "git") return "git";
  if (evidence.kind === "work_item") return "work_item";
  return "attention";
}

function chooseNativeFocus(input: {
  recentUnlanded: ScoutbotRecentWorkSignal[];
  riskyWorktrees: ScoutbotWorktreeSignal[];
  riskyAttention: Array<{
    project: ScoutbotAttentionProjectSignal;
    evidence: ScoutbotAttentionEvidenceSignal;
  }>;
}): {
  summary: string;
  priority: number;
  evidenceIds: Array<Omit<ScoutbotEvidenceRef, "id"> & { id?: string }>;
} {
  const recent = input.recentUnlanded[0];
  if (recent) {
    return {
      summary: `Start with "${recent.title}" because it appears complete but not landed.`,
      priority: 95,
      evidenceIds: [{
        kind: "recent_work",
        summary: recentWorkSummary(recent),
        projectRoot: recent.projectRoot,
        agentId: recent.agentId ?? null,
        recordId: recent.id,
        observedAt: recent.completedAt ?? null,
      }],
    };
  }

  const risky = input.riskyAttention[0];
  if (risky) {
    return {
      summary: `Start with ${risky.project.projectName}: ${risky.evidence.summary}`,
      priority: 85,
      evidenceIds: [{
        kind: evidenceKindForAttention(risky.evidence),
        summary: risky.evidence.summary,
        projectRoot: risky.project.projectRoot,
        agentId: risky.evidence.agentId ?? null,
        recordId: risky.evidence.id ?? risky.evidence.flightId ?? risky.evidence.workId ?? risky.evidence.messageId ?? null,
        observedAt: risky.evidence.at ?? risky.project.lastActivityAt,
      }],
    };
  }

  const worktree = input.riskyWorktrees[0];
  if (worktree) {
    return {
      summary: `Start with ${worktree.projectName ?? worktree.projectRoot}; the worktree has local or branch drift.`,
      priority: 75,
      evidenceIds: [{
        kind: "worktree",
        summary: worktreeSummary(worktree),
        projectRoot: worktree.projectRoot,
        recordId: worktree.id ?? worktree.projectRoot,
        observedAt: worktree.lastCommitAt,
      }],
    };
  }

  return {
    summary: "No clear operator focus emerged from the provided signals.",
    priority: 5,
    evidenceIds: [],
  };
}

function headlineFor(input: {
  recentUnlandedCount: number;
  riskyWorktreeCount: number;
  riskyAttentionCount: number;
}): string {
  if (input.recentUnlandedCount > 0) {
    return `${input.recentUnlandedCount} completed item${input.recentUnlandedCount === 1 ? "" : "s"} need landing review`;
  }
  if (input.riskyAttentionCount > 0) {
    return `${input.riskyAttentionCount} Scout attention signal${input.riskyAttentionCount === 1 ? "" : "s"} need review`;
  }
  if (input.riskyWorktreeCount > 0) {
    return `${input.riskyWorktreeCount} worktree${input.riskyWorktreeCount === 1 ? "" : "s"} have local or branch drift`;
  }
  return "No urgent Scoutbot focus from the provided signals";
}

function confidenceFor(
  input: ScoutbotSituationInput,
  missingData: string[],
): "low" | "medium" | "high" {
  const present = [
    input.broker,
    input.attention,
    input.worktrees,
    input.recentWork,
  ].filter(Boolean).length;
  if (present >= 3 && missingData.length <= 1) return "high";
  if (present >= 2) return "medium";
  return "low";
}

function compactText(value: string, limit: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= limit) return compacted;
  return `${compacted.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}
