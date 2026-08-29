import type { Message } from "./types.ts";

export type ConversationFailureNotice = {
  target: string;
  explanation: string;
  technicalDetail: string | null;
};

const FAILED_TO_RESPOND_PATTERN = /^(.+?) failed to respond\.(?:\r?\n([\s\S]*))?$/i;
const UNACCEPTED_REQUEST_PATTERN = /^(.+?) sent a request to (.+?), but no operator session accepted it\.$/i;
// Broker bounce for a branch-scoped agent identity that was replaced when the
// checkout moved (see staleLocalEndpointReason / staleLocalAgentReason in
// packages/runtime). Raw form names endpoint ids; readers get the consequence.
const SUPERSEDED_REGISTRATION_PATTERN =
  /^(?:target agent|agent|endpoint)\s+(\S+) is a superseded local registration replaced by current setup(?:; replacement agent is (\S+))?\.?$/i;

export function conversationalTargetLabel(target: string): string {
  const trimmed = target.trim();
  if (!/^openscout-/i.test(trimmed)) return trimmed;
  const generatedName = trimmed
    .replace(/^openscout-/i, "")
    .replace(/-\d+$/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return generatedName || trimmed;
}

function failureExplanation(detail: string | null): string {
  if (!detail) return "Scout couldn’t complete the request.";
  if (/no rollout found for thread id|no conversation found with session id/i.test(detail)) {
    return "The session linked to this conversation is no longer available.";
  }
  if (/working directory|cwd does not exist|project (?:folder|directory).+does not exist/i.test(detail)) {
    return "Its project folder is no longer available.";
  }
  return "Scout couldn’t complete the request.";
}

function agentHandleFromId(agentId: string): string | null {
  const handle = agentId.replace(/^endpoint\./, "").split(".")[0]?.trim();
  return handle || null;
}

function titleCaseHandle(handle: string): string {
  return handle
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Turns broker-authored invocation failures into conversation copy. The raw
 * adapter error remains available for progressive disclosure, but it is not
 * the first thing a person has to read in a chat.
 */
export function conversationFailureNotice(
  message: Pick<Message, "actorId" | "body" | "class">,
): ConversationFailureNotice | null {
  if (
    message.class === "system"
    && (message.actorId === "scout" || message.actorId === "system")
  ) {
    const superseded = SUPERSEDED_REGISTRATION_PATTERN.exec(message.body.trim());
    if (!superseded) return null;
    const staleRef = superseded[1]?.trim() ?? "";
    const replacementId = superseded[2]?.trim() || null;
    const handle = replacementId
      ? agentHandleFromId(replacementId)
      : agentHandleFromId(staleRef);
    const target = handle ? titleCaseHandle(handle) : "This agent";
    const replacementBranch = replacementId?.split(".")[1] ?? null;
    return {
      target,
      explanation: replacementId
        ? `This chat points at a retired session of the agent — it now runs on ${
            replacementBranch ?? "a new branch"
          }. Start a fresh chat with @${handle} to reach it.`
        : "This chat points at a retired session of the agent, and no replacement is registered.",
      technicalDetail: message.body.trim(),
    };
  }
  if (message.class !== "status" || message.actorId !== "system") return null;
  const match = FAILED_TO_RESPOND_PATTERN.exec(message.body.trim());
  if (!match) {
    const unaccepted = UNACCEPTED_REQUEST_PATTERN.exec(message.body.trim());
    const target = unaccepted?.[2]?.trim();
    if (!target) return null;
    return {
      target,
      explanation: "No available Scout session accepted this request.",
      technicalDetail: null,
    };
  }

  const target = match[1]?.trim();
  if (!target) return null;
  const technicalDetail = match[2]?.trim() || null;
  return {
    target,
    explanation: failureExplanation(technicalDetail),
    technicalDetail,
  };
}

export function conversationalMessagePreview(body: string): string {
  const match = FAILED_TO_RESPOND_PATTERN.exec(body.trim());
  if (!match) return body;
  const target = match[1]?.trim();
  if (!target) return body;
  const technicalDetail = match[2]?.trim() || null;
  return `${conversationalTargetLabel(target)} couldn’t reply. ${failureExplanation(technicalDetail)}`;
}

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
