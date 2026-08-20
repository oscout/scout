import {
  formatAgentReferenceIdentity,
  parseAgentIdentity,
  type AgentIdentityCandidate,
  type ScoutAgentCard,
} from "@openscout/protocol";

function cardReferenceCandidate(card: ScoutAgentCard): AgentIdentityCandidate {
  const parsedSelector = card.selector ? parseAgentIdentity(card.selector) : null;
  const definitionId = card.definitionId || card.handle;
  return {
    agentId: card.agentId,
    definitionId,
    nodeQualifier: parsedSelector?.nodeQualifier,
    workspaceQualifier: parsedSelector?.workspaceQualifier,
    referenceId: card.branch || parsedSelector?.workspaceQualifier || card.sessionId || card.agentId,
  };
}

export function formatScoutAgentCardContact(card: ScoutAgentCard): string {
  const candidate = cardReferenceCandidate(card);
  return formatAgentReferenceIdentity(
    candidate,
    [candidate],
  );
}

export function renderScoutAgentCard(card: ScoutAgentCard): string {
  const lines = [
    card.displayName,
    `Contact: ${formatScoutAgentCardContact(card)}`,
    `Agent: ${card.agentId}`,
    `Project: ${card.projectRoot}`,
    `Runtime: ${card.harness} via ${card.transport}${card.sessionId ? ` (${card.sessionId})` : ""}`,
  ];

  if (card.description) {
    lines.push(`About: ${card.description}`);
  }
  if (card.selector) {
    lines.push(`Selector: ${card.selector}`);
  }
  if (card.defaultSelector) {
    lines.push(`Default: ${card.defaultSelector}`);
  }
  if (card.branch) {
    lines.push(`Branch: ${card.branch}`);
  }
  lines.push(`Broker: ${card.brokerRegistered ? "registered" : "offline"}`);
  if (card.inboxConversationId) {
    lines.push(`Inbox: ${card.inboxConversationId}`);
  }
  if (card.returnAddress.conversationId) {
    lines.push(`Reply-To: ${card.returnAddress.conversationId}`);
  }
  if (card.skills && card.skills.length > 0) {
    lines.push(`Skills: ${card.skills.map((skill) => skill.name).join(", ")}`);
  }
  if (card.documentationUrl) {
    lines.push(`Docs: ${card.documentationUrl}`);
  }

  return lines.join("\n");
}
