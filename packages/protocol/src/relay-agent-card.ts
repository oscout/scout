import type { AgentEndpoint, AgentHarness } from "./actors.js";
import type { MetadataMap, ScoutId } from "./common.js";

export interface RelayReturnAddress {
  actorId: ScoutId;
  handle: string;
  displayName?: string;
  selector?: string;
  defaultSelector?: string;
  conversationId?: ScoutId;
  replyToMessageId?: ScoutId;
  nodeId?: ScoutId;
  projectRoot?: string;
  sessionId?: string;
  metadata?: MetadataMap;
}

export interface RelayAgentCardLifecycle {
  kind: "persistent" | "one_time";
  createdAt?: number;
  createdById?: ScoutId;
  expiresAt?: number;
  maxUses?: number;
  inboxConversationId?: ScoutId;
}

export interface RelayAgentCard {
  id: ScoutId;
  agentId: ScoutId;
  definitionId: ScoutId;
  displayName: string;
  handle: string;
  selector?: string;
  defaultSelector?: string;
  projectName?: string;
  projectRoot: string;
  currentDirectory: string;
  harness: AgentHarness;
  transport: AgentEndpoint["transport"];
  sessionId?: string;
  branch?: string;
  createdAt: number;
  createdById?: ScoutId;
  brokerRegistered: boolean;
  inboxConversationId?: ScoutId;
  lifecycle?: RelayAgentCardLifecycle;
  returnAddress: RelayReturnAddress;
  metadata?: MetadataMap;
}

export function buildRelayReturnAddress(input: RelayReturnAddress): RelayReturnAddress {
  const next: RelayReturnAddress = {
    actorId: input.actorId,
    handle: input.handle.trim(),
  };
  if (input.displayName?.trim()) {
    next.displayName = input.displayName.trim();
  }
  if (input.selector?.trim()) {
    next.selector = input.selector.trim();
  }
  if (input.defaultSelector?.trim()) {
    next.defaultSelector = input.defaultSelector.trim();
  }
  if (input.conversationId?.trim()) {
    next.conversationId = input.conversationId.trim();
  }
  if (input.replyToMessageId?.trim()) {
    next.replyToMessageId = input.replyToMessageId.trim();
  }
  if (input.nodeId?.trim()) {
    next.nodeId = input.nodeId.trim();
  }
  if (input.projectRoot?.trim()) {
    next.projectRoot = input.projectRoot.trim();
  }
  if (input.sessionId?.trim()) {
    next.sessionId = input.sessionId.trim();
  }
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    next.metadata = input.metadata;
  }
  return next;
}
