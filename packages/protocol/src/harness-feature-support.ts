export type HarnessSupportLevel = "yes" | "partial" | "no" | "unknown";

export type HarnessFeatureDowngrade =
  | "native"
  | "embedded"
  | "reference_text"
  | "prompt_only"
  | "debug_only"
  | "unsupported";

export interface HarnessFeatureEvidence {
  kind: "adapter_spec" | "catalog" | "runtime_check" | "manual" | "upstream";
  ref: string;
}

export interface HarnessFeatureSupport {
  level: HarnessSupportLevel;
  reason?: string;
  evidence?: HarnessFeatureEvidence[];
  downgrade?: HarnessFeatureDowngrade;
}

export interface HarnessFeatureSupportMap {
  prompts?: {
    systemPrompt?: HarnessFeatureSupport;
    agentInstructions?: HarnessFeatureSupport;
    promptFiles?: HarnessFeatureSupport;
    images?: HarnessFeatureSupport;
  };
  session?: {
    start?: HarnessFeatureSupport;
    resume?: HarnessFeatureSupport;
    interrupt?: HarnessFeatureSupport;
    shutdown?: HarnessFeatureSupport;
    concurrentTurns?: HarnessFeatureSupport;
    traceObserve?: HarnessFeatureSupport;
    fork?: HarnessFeatureSupport;
    nativeThreadClone?: HarnessFeatureSupport;
    steer?: HarnessFeatureSupport;
    followUps?: HarnessFeatureSupport;
  };
  interaction?: {
    questions?: HarnessFeatureSupport;
    approvals?: HarnessFeatureSupport;
    serverRequests?: HarnessFeatureSupport;
    toolSuspensions?: HarnessFeatureSupport;
    planApproval?: HarnessFeatureSupport;
  };
  tools?: {
    command?: HarnessFeatureSupport;
    fileChange?: HarnessFeatureSupport;
    subagent?: HarnessFeatureSupport;
    taskProjection?: HarnessFeatureSupport;
    mcpStdio?: HarnessFeatureSupport;
    mcpSse?: HarnessFeatureSupport;
    mcpStreamableHttp?: HarnessFeatureSupport;
  };
  events?: {
    rawStream?: HarnessFeatureSupport;
    normalizedStream?: HarnessFeatureSupport;
    displayState?: HarnessFeatureSupport;
    subagentEvents?: HarnessFeatureSupport;
    taskEvents?: HarnessFeatureSupport;
    usageEvents?: HarnessFeatureSupport;
  };
  limits?: {
    maxTurns?: HarnessFeatureSupport;
    maxModelCalls?: HarnessFeatureSupport;
    maxDuration?: HarnessFeatureSupport;
  };
  auth?: {
    apiKey?: HarnessFeatureSupport;
    authFile?: HarnessFeatureSupport;
    oauthToken?: HarnessFeatureSupport;
    localLogin?: HarnessFeatureSupport;
  };
  debug?: {
    tmuxAttach?: HarnessFeatureSupport;
    logs?: HarnessFeatureSupport;
    rawTranscript?: HarnessFeatureSupport;
  };
}

export function normalizeHarnessSupportLevel(value: string | null | undefined): HarnessSupportLevel {
  switch (value?.trim().toLowerCase()) {
    case "yes":
    case "supported":
    case "true":
      return "yes";
    case "partial":
    case "degraded":
      return "partial";
    case "no":
    case "unsupported":
    case "false":
      return "no";
    case "unknown":
    default:
      return "unknown";
  }
}

export function isHarnessFeatureUsable(
  feature: Pick<HarnessFeatureSupport, "level"> | null | undefined,
): boolean {
  return feature?.level === "yes" || feature?.level === "partial";
}

export function unsupportedHarnessFeature(reason: string, evidence: HarnessFeatureEvidence[] = []): HarnessFeatureSupport {
  return {
    level: "no",
    reason,
    evidence,
    downgrade: "unsupported",
  };
}
