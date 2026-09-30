import { readChatMessageCorrection } from "@openscout/protocol";
import type { ChatMessage } from "./chat-api.ts";

export function chatMessagePreviewText(message: ChatMessage): string {
  if (readChatMessageCorrection(message.metadata)?.deletedAt != null) return "Message deleted";
  return message.body.trim().slice(0, 100) || message.attachments?.map(file => file.fileName || "Attachment").join(", ").slice(0, 100) || "Empty message";
}
