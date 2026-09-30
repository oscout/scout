/** Only bounded aggregate signals from an observed session may be sent to Jev. */
export type RetrospectiveObservedEvent = {
  kind?: string;
  tool?: string;
  /** Command text for shell tools. Read locally to pick a bucket; never sent. */
  arg?: string;
};

export type RetrospectiveObservedData = {
  events?: RetrospectiveObservedEvent[];
  files?: Array<{ state?: string }>;
  metadata?: {
    session?: { model?: string | null; adapterType?: string | null };
    topology?: {
      agents?: unknown[];
      relationships?: Array<{ kind?: string }>;
    };
  };
};

export type SessionRetrospectiveProfile = {
  schema: "openscout.session-retrospective.v1";
  observedEventCount: number;
  toolActivity: {
    readOrSearch: number;
    editOrWrite: number;
    testOrBuild: number;
    command: number;
    other: number;
  };
  fileActivity: { read: number; created: number; modified: number };
  knownAgentCount: number;
  observedSpawnedRelationshipCount: number;
};

// Shell commands that run tests, builds, or type/lint checks. Only the bucket
// count leaves the machine, never the command text.
const TEST_OR_BUILD_COMMAND = /(^|[\s/;&|(:])(test|tests|build|typecheck|lint|check|tsc|pytest|vitest|jest|xcodebuild|ctest)(?=$|[\s:;&|)])/i;

function toolBucket(tool: string | undefined, arg?: string): keyof SessionRetrospectiveProfile["toolActivity"] {
  const normalized = tool?.trim().toLowerCase() ?? "";
  if (/^(bash|shell|exec|command|terminal)$/.test(normalized) && typeof arg === "string" && TEST_OR_BUILD_COMMAND.test(arg)) {
    return "testOrBuild";
  }
  if (/^(read|grep|glob|search|find|ls|list|inspect|cat|rg)$/.test(normalized)) return "readOrSearch";
  if (/^(edit|write|patch|apply_patch|strreplace|multiedit|create)$/.test(normalized)) return "editOrWrite";
  if (/^(test|build|check|lint|typecheck|verify)$/.test(normalized)) return "testOrBuild";
  if (/^(bash|shell|exec|command|terminal)$/.test(normalized)) return "command";
  return "other";
}

export function buildSessionRetrospectiveProfile(data: RetrospectiveObservedData): SessionRetrospectiveProfile {
  const events = Array.isArray(data.events) ? data.events : [];
  const files = Array.isArray(data.files) ? data.files : [];
  const toolActivity: SessionRetrospectiveProfile["toolActivity"] = {
    readOrSearch: 0,
    editOrWrite: 0,
    testOrBuild: 0,
    command: 0,
    other: 0,
  };
  for (const event of events) {
    if (event.kind === "tool") toolActivity[toolBucket(event.tool, event.arg)] += 1;
  }
  const fileActivity: SessionRetrospectiveProfile["fileActivity"] = { read: 0, created: 0, modified: 0 };
  for (const file of files) {
    if (file.state === "read" || file.state === "created" || file.state === "modified") {
      fileActivity[file.state] += 1;
    }
  }
  const relationships = data.metadata?.topology?.relationships ?? [];
  return {
    schema: "openscout.session-retrospective.v1",
    observedEventCount: events.length,
    toolActivity,
    fileActivity,
    knownAgentCount: data.metadata?.topology?.agents?.length ?? (data.metadata?.session?.model ? 1 : 0),
    observedSpawnedRelationshipCount: relationships.filter((relationship) => relationship.kind === "spawned").length,
  };
}

export type JevLabelId = "exploration" | "implementation" | "debugging" | "delegation";
export const JEV_LABEL_IDS: readonly JevLabelId[] = ["exploration", "implementation", "debugging", "delegation"];
export const JEV_MODEL = "jev-latest";

const LABEL_QUESTIONS: Record<JevLabelId, { description: string; instructions: string }> = {
  exploration: {
    description: "A session with substantial information gathering, reading, or search activity.",
    instructions: "Does the observed activity profile support the tentative descriptive label 'Exploration'?",
  },
  implementation: {
    description: "A session with observed editing, writing, creation, or file modification activity.",
    instructions: "Does the observed activity profile support the tentative descriptive label 'Implementation'?",
  },
  debugging: {
    description: "A session with observed test or build activity.",
    instructions: "Does the observed activity profile support the tentative descriptive label 'Testing and build work'?",
  },
  delegation: {
    description: "A session whose observed harness topology contains spawned-agent relationships.",
    instructions: "Does the observed activity profile support the tentative descriptive label 'Delegation'?",
  },
};

export function jevRetrospectiveQuestions(): Record<string, unknown> {
  return Object.fromEntries(JEV_LABEL_IDS.map((id) => [id, {
    type: "noul",
    instructions: LABEL_QUESTIONS[id].instructions,
    criteria: {
      true: LABEL_QUESTIONS[id].description,
      false: "The observed activity profile does not provide enough support for this label.",
    },
  }]));
}

/**
 * The complete JSON body sent to Jev. The client renders this exact object in
 * the consent preview; the server rebuilds it from its own session read and
 * sends it only when it matches what the operator reviewed.
 */
export function buildJevRequestBody(profile: SessionRetrospectiveProfile): {
  model: string;
  state: SessionRetrospectiveProfile;
  questions: Record<string, unknown>;
} {
  return { model: JEV_MODEL, state: profile, questions: jevRetrospectiveQuestions() };
}
export type JevLabelEvidence = { id: JevLabelId; probability: number; rationale: string };

export function retrospectiveLabelEvidence(profile: SessionRetrospectiveProfile): Array<{
  id: JevLabelId;
  hasEvidence: boolean;
  rationale: string;
}> {
  const readSearch = profile.toolActivity.readOrSearch;
  const filesRead = profile.fileActivity.read;
  const writes = profile.toolActivity.editOrWrite;
  const changedFiles = profile.fileActivity.created + profile.fileActivity.modified;
  const tests = profile.toolActivity.testOrBuild;
  const spawned = profile.observedSpawnedRelationshipCount;
  return [
    { id: "exploration", hasEvidence: readSearch + filesRead > 0, rationale: `${readSearch} read/search tool actions and ${filesRead} file reads were observed.` },
    { id: "implementation", hasEvidence: writes + changedFiles > 0, rationale: `${writes} edit/write tool actions and ${changedFiles} created or modified files were observed.` },
    { id: "debugging", hasEvidence: tests > 0, rationale: `${tests} test/build tool actions were observed.` },
    { id: "delegation", hasEvidence: spawned > 0, rationale: `${spawned} explicit spawned-agent relationships were observed in harness topology.` },
  ];
}

export function normalizeJevLabels(
  profile: SessionRetrospectiveProfile,
  answers: Partial<Record<JevLabelId, number>>,
  threshold = 0.72,
): JevLabelEvidence[] {
  const evidence = retrospectiveLabelEvidence(profile);
  return evidence
    .filter((item) => item.hasEvidence && Number.isFinite(answers[item.id]) && (answers[item.id] ?? 0) >= threshold)
    .map((item) => ({ ...item, probability: answers[item.id]! }))
    .sort((left, right) => right.probability - left.probability)
    .slice(0, 2);
}
