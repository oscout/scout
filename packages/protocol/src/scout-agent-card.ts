import type { AgentEndpoint, AgentHarness } from "./actors.js";
import type { MetadataMap, ScoutId } from "./common.js";

export interface ScoutAgentProvider {
  organization?: string;
  url?: string;
}

export interface ScoutAgentSkill {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface ScoutSupportedInterface {
  protocol: string;
  transport?: string;
  url?: string;
  description?: string;
}

export interface ScoutSecurityScheme {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
}

export interface ScoutReturnAddress {
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

export interface ScoutAgentCardLifecycle {
  kind: "persistent" | "one_time";
  createdAt?: number;
  createdById?: ScoutId;
  expiresAt?: number;
  maxUses?: number;
  inboxConversationId?: ScoutId;
}

/**
 * Scout's local discovery and routing card for one addressable agent target.
 *
 * This is intentionally not the A2A wire-level `AgentCard`, but it overlaps
 * with A2A on discovery-oriented fields such as provider, skills, interfaces,
 * and security hints so Scout can project cleanly to adjacent protocols later.
 */
export interface ScoutAgentCard {
  id: ScoutId;
  agentId: ScoutId;
  definitionId: ScoutId;
  displayName: string;
  description?: string;
  provider?: ScoutAgentProvider;
  version?: string;
  documentationUrl?: string;
  skills?: ScoutAgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  supportedInterfaces?: ScoutSupportedInterface[];
  securitySchemes?: Record<string, ScoutSecurityScheme>;
  securityRequirements?: string[][];
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
  lifecycle?: ScoutAgentCardLifecycle;
  returnAddress: ScoutReturnAddress;
  metadata?: MetadataMap;
}

export function buildScoutReturnAddress(input: ScoutReturnAddress): ScoutReturnAddress {
  const next: ScoutReturnAddress = {
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
