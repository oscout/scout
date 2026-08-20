import type { Message } from "./types.ts";

export function isNoisyConversationStatusMessage(
  message: Pick<Message, "actorId" | "body" | "class">,
): boolean {
  if (message.class !== "status") return false;
  if (message.actorId !== "system") return false;
  return (
    message.body.includes("failed to respond") &&
    message.body.includes("snapshot.messages")
  );
}
