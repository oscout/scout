// Plan documents found on disk, as GET /api/plan-documents serves them.

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
