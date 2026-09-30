import { createContext } from "react";
import type { ChatLocalScope } from "./chat-local-state.ts";

export const ChatCorrectionScope = createContext<ChatLocalScope | null>(null);

export interface ChatCorrectionDraft {
  body: string;
  expectedRevision: number;
}

export function parseChatCorrectionDraft(value: unknown): ChatCorrectionDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<ChatCorrectionDraft>;
  return typeof draft.body === "string" && draft.body.length <= 32000
    && typeof draft.expectedRevision === "number" && Number.isSafeInteger(draft.expectedRevision)
    && draft.expectedRevision >= 0
    ? { body: draft.body, expectedRevision: draft.expectedRevision } : null;
}
