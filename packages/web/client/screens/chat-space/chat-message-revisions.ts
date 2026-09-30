import { readChatMessageCorrection } from "@openscout/protocol";
import type { ChatMessage } from "./chat-api.ts";

/** A poll started before a confirmed edit must not restore an earlier body. */
export function newestChatMessage(current: ChatMessage | undefined, incoming: ChatMessage): ChatMessage {
  if (!current || current.id !== incoming.id) return incoming;
  return (readChatMessageCorrection(current.metadata)?.revision ?? 0) > (readChatMessageCorrection(incoming.metadata)?.revision ?? 0) ? current : incoming;
}
export function mergeChatMessageRevisions(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const known = new Map(current.map(message => [message.id, message]));
  return incoming.map(message => newestChatMessage(known.get(message.id), message));
}
