import type { ScoutId } from "./common.js";

export type HarnessNativeInteractionKind =
  | "question"
  | "plan_approval"
  | "task_projection"
  | "subagent_activity"
  | "tool_approval"
  | "follow_up"
  | "steer";

export type ScoutNativeInteractionTargetKind =
  | "question"
  | "work_item"
  | "invocation"
  | "flight"
  | "message"
  | "session_projection";

export interface HarnessNativeInteractionSource {
  harness: string;
  sessionId?: ScoutId;
  harnessThreadId?: string;
  toolCallId?: string;
  nativeName?: string;
  rawEventId?: string;
}

export interface HarnessNativeInteraction {
  id: ScoutId;
  kind: HarnessNativeInteractionKind;
  source: HarnessNativeInteractionSource;
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  observedAt: number;
}

export interface HarnessNativeInteractionMapping {
  kind: HarnessNativeInteractionKind;
  nativeNames: string[];
  scoutTargets: ScoutNativeInteractionTargetKind[];
  description: string;
}

export const DEFAULT_HARNESS_NATIVE_INTERACTION_MAPPINGS: readonly HarnessNativeInteractionMapping[] = [
  {
    kind: "question",
    nativeNames: ["ask_user"],
    scoutTargets: ["question", "session_projection"],
    description: "A harness-native user question becomes a Scout question.",
  },
  {
    kind: "plan_approval",
    nativeNames: ["submit_plan"],
    scoutTargets: ["work_item", "session_projection"],
    description: "A harness-native plan review becomes a Scout work item or review-needed projection.",
  },
  {
    kind: "task_projection",
    nativeNames: ["task_write", "task_update", "task_complete", "task_check"],
    scoutTargets: ["work_item", "session_projection"],
    description: "Harness-native task tools project into Scout work item task state.",
  },
  {
    kind: "subagent_activity",
    nativeNames: ["subagent"],
    scoutTargets: ["invocation", "flight", "session_projection"],
    description: "Harness-native child agent activity links to child invocations or observed child runs.",
  },
  {
    kind: "tool_approval",
    nativeNames: ["tool_approval_required"],
    scoutTargets: ["session_projection"],
    description: "A harness-native tool approval projects into session state.",
  },
  {
    kind: "follow_up",
    nativeNames: ["follow_up"],
    scoutTargets: ["message", "session_projection"],
    description: "A queued follow-up remains in the same conversation/session context.",
  },
  {
    kind: "steer",
    nativeNames: ["steer"],
    scoutTargets: ["flight", "message", "session_projection"],
    description: "A steering request redirects the active session or flight with an explicit reason.",
  },
] as const;

export function scoutTargetsForNativeInteraction(
  kind: HarnessNativeInteractionKind,
): ScoutNativeInteractionTargetKind[] {
  return [...(DEFAULT_HARNESS_NATIVE_INTERACTION_MAPPINGS.find(mapping => mapping.kind === kind)?.scoutTargets ?? [])];
}

export function nativeInteractionKindForName(nativeName: string): HarnessNativeInteractionKind | undefined {
  const normalized = nativeName.trim();
  return DEFAULT_HARNESS_NATIVE_INTERACTION_MAPPINGS.find(mapping => mapping.nativeNames.includes(normalized))?.kind;
}
