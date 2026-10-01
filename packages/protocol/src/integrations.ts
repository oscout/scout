/** Token-free contracts for broker-owned, local Slack setup. */
export type SlackSetupState = "awaiting_workspace" | "awaiting_authority" | "awaiting_app" | "awaiting_credentials" | "ready_to_start";

export interface SlackProjectBinding {
  agentId: string;
  definitionId: string;
  projectPath: string;
  nodeId: string;
  revision: number;
}

export interface SlackSetupRequest {
  provider: "slack";
  mode: "project_agent";
  projectPath: string;
  agentId?: string;
  displayName?: string;
  workspaceId?: string;
  idempotencyKey?: string;
}

export interface SlackCredentialReference {
  backend: "secret_cli" | "private_file";
  appTokenKey: string;
  botTokenKey: string;
}

export interface SlackInstallationCredentials {
  reference: SlackCredentialReference;
  botId: string;
  botUserId: string;
  verifiedAt: number;
  allowedUserIds: string[];
  allowedChannelIds: string[];
}

export interface SlackVerificationEvidence {
  bindingRevision: number;
  credentialVerifiedAt: number;
  verifiedAt: number;
  channelId: string;
  threadTs: string;
  first: { eventId: string; invocationId: string; messageId: string; resultDeliveredAt: number };
  followUp: { eventId: string; invocationId: string; messageId: string; resultDeliveredAt: number };
}

export interface SlackSetupOperation {
  id: string;
  provider: "slack";
  mode: "project_agent";
  ownerRealmId: string;
  binding: SlackProjectBinding;
  displayName: string;
  manifestHash: string;
  workspaceId?: string;
  /** Claimed by the operator; not yet validated with Slack. */
  appId?: string;
  authorityConfirmedAt?: number;
  credentials?: SlackInstallationCredentials;
  desiredState?: "running" | "paused" | "disconnected";
  verification?: SlackVerificationEvidence;
  workerError?: { code: "worker_unavailable" | "worker_exited"; at: number };
  state: SlackSetupState;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type SlackSetupResumeRequest = { expectedRevision: number } & (
  | { action: "choose_workspace"; workspaceId: string }
  | { action: "confirm_authority" }
  | { action: "register_app"; appId: string }
);

export interface SlackSetupReceipt {
  operation: SlackSetupOperation;
  nextAction: {
    id: string;
    kind: "choose_workspace" | "confirm_authority" | "create_or_connect_app" | "connect_secrets" | "start_worker" | "wait_for_worker" | "verify_integration" | "complete";
    title: string;
  };
  /** Setup bookkeeping never implies a connected or verified integration. */
  readiness: "not_connected" | "connected_unverified" | "verified";
  eventQueue?: { pending: number; retrying: number };
  worker?: { generation: number; state: "starting" | "connected" | "stopped" | "expired"; expiresAt: number; updatedAt: number };
}
