export type Scope = { all: boolean; agentIds: string[]; projectIds: string[] };
export type Principal = { id: string; publicKey: string; kind: "person" | "service"; label: string };
export type Agent = { id: string; displayName: string; projectId?: string; projectName?: string; actions: string[] };
export type Grant = { id: string; issuerId: string; subjectId: string; scope: Scope; actions: string[]; expiresAt: number; revoked: boolean };
export type Delegation = { id: string; principalId: string; devicePublicKey: string; expiresAt: number; scope: Scope; actions: string[]; signature?: string };
export type NetworkState = {
  pagination?: { offset: number; limit: number; nextOffset: number | null };
  network: { id: string; label: string; revision: number; expiresAt: number; lastReceivedAt?: number };
  viewerDevice: { scope: Scope; actions: string[]; expiresAt: number };
  viewer: { principal: Principal; role: string }; canAdmin: boolean; canManageMembership: boolean; executionBoundary: string;
  principals: Array<{ principal: Principal; role: string }>; grants: Grant[]; delegations: Delegation[];
  devices: Array<{ keyId: string; publicKey: string; principalId: string }>;
  resources: { agents: Agent[]; projects: Array<{ id: string; name: string; includesFutureAgents: boolean }> };
  signedRevocations: Array<{ artifact: { issuerId: string; targetKind: string; targetId: string } }>;
  revokedPrincipalIds: string[]; revokedDeviceIds: string[]; revokedDelegationIds: string[]; revokedGrantIds: string[];
};
export type Work = { id: string; agentId: string; projectId?: string; state: string; summary: string; createdAt: number };
export type Session = { authenticated: boolean; csrf?: string; user?: { login: string; principalId?: string; canSign?: boolean }; canSign?: boolean };
