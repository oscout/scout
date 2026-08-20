import type { CaptureDeliveryMode } from "./session-start.ts";

export type ContextCaptureDraftSeed = {
  intent?: ContextCaptureIntent;
  agentId?: string;
  conversationId?: string;
  projectPath?: string;
  message?: string;
  files?: File[];
  attachmentFeedback?: string;
  preferExistingChat?: boolean;
  forwardContext?: ForwardContextSource;
  forwardContextMode?: ForwardContextMode;
};

export type ContextCaptureIntent = "new-task" | "route-capture" | "forward-message";

export type ForwardContextMode = "selected-message" | "recent-context" | "instructions-only";

/**
 * Scout-owned, visible conversation material that can seed a fresh task.
 * `recentContext` is a bounded excerpt, never a claim of full harness context
 * or an AI-generated summary.
 */
export type ForwardContextSource = {
  selectedMessage: string;
  selectedMessageId: string;
  sourceConversationId: string;
  recentContext?: string;
  recentMessageCount: number;
};

export type ContextCaptureDraft = {
  intent: ContextCaptureIntent;
  agentId?: string;
  conversationId?: string;
  message: string;
  files: File[];
  attachmentFeedback: string | null;
  mode: CaptureDeliveryMode;
  projectPath: string;
  projectQuery: string;
  forwardContext?: ForwardContextSource;
  forwardContextMode: ForwardContextMode;
};

export function contextCaptureDraftHasContent(
  draft: Pick<ContextCaptureDraft, "message" | "files" | "forwardContext"> | null | undefined,
): boolean {
  return Boolean(draft && (
    draft.message.trim().length > 0
    || draft.files.length > 0
    || draft.forwardContext
  ));
}

function fileKey(file: File): string {
  return [file.name, file.type, file.size, file.lastModified].join(":");
}

function mergeFiles(current: readonly File[], incoming: readonly File[]): File[] {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((file) => {
    const key = fileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reopen New Chat from its last unsent state. A fresh launch context may
 * refine the target or add captures, but it must not erase typed text or
 * previously attached files merely because the sheet was closed.
 */
export function mergeContextCaptureDraft(
  current: ContextCaptureDraft | null,
  seed: ContextCaptureDraftSeed,
): ContextCaptureDraft {
  const intent = seed.intent ?? current?.intent ?? "new-task";
  const preserveRoute = intent === "route-capture";
  const preserveForward = intent === "forward-message";
  return {
    intent,
    ...(preserveRoute && (seed.agentId ?? current?.agentId)
      ? { agentId: seed.agentId ?? current?.agentId }
      : {}),
    ...(preserveRoute && (seed.conversationId ?? current?.conversationId)
      ? { conversationId: seed.conversationId ?? current?.conversationId }
      : {}),
    message: seed.message ?? current?.message ?? "",
    files: mergeFiles(current?.files ?? [], seed.files ?? []),
    attachmentFeedback: seed.attachmentFeedback ?? current?.attachmentFeedback ?? null,
    mode: !preserveRoute
      ? "new-session"
      : seed.preferExistingChat === undefined
      ? current?.mode ?? "new-session"
      : seed.preferExistingChat
        ? "existing-chat"
        : "new-session",
    projectPath: seed.projectPath ?? current?.projectPath ?? "",
    projectQuery: current?.projectQuery ?? "",
    ...(preserveForward && (seed.forwardContext ?? current?.forwardContext)
      ? { forwardContext: seed.forwardContext ?? current?.forwardContext }
      : {}),
    forwardContextMode: preserveForward
      ? seed.forwardContextMode ?? current?.forwardContextMode ?? "selected-message"
      : "selected-message",
  };
}

export function dictationBlocksContextCaptureClose(
  state: "idle" | "starting" | "recording" | "processing" | null | undefined,
): boolean {
  return state === "starting" || state === "recording" || state === "processing";
}
