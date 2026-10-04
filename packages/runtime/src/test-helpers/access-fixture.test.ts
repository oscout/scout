import { generateKeyPairSync } from "node:crypto";
import { nodeKeyId, type NodeIdentity } from "../node-identity.js";
import { ACCESS_PROTOCOL, signAccessArtifact, type AccessPolicy, type AccessGrant, type AccessDelegation, type AccessPrincipal } from "../mesh-access.js";
export function accessTestKey(): NodeIdentity {
  const pair = generateKeyPairSync("ed25519");
  return { version: 1, createdAt: Date.now(), publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}
export function accessTestFixture(audience = nodeKeyId(accessTestKey().publicKey), now = Date.now()) {
  const owner = accessTestKey(), service = accessTestKey(), member = accessTestKey(), admin = accessTestKey(), device = accessTestKey();
  const person = (key: NodeIdentity, label: string, kind: "person" | "service" = "person"): AccessPrincipal => ({ id: nodeKeyId(key.publicKey), publicKey: key.publicKey, label, kind });
  const root = person(owner, "Owner"), subject = person(service, "Worker", "service"), adminPrincipal = person(admin, "Admin");
  const policy = signAccessArtifact<AccessPolicy>(owner, { protocol: ACCESS_PROTOCOL, kind: "policy", networkId: root.id, root, label: "Test", revision: 1,
    issuedAt: now - 100, expiresAt: now + 60_000, members: [{ principal: subject, role: "service" }, { principal: person(member, "Member"), role: "member" }, { principal: adminPrincipal, role: "admin" }],
    revokedPrincipalIds: [], revokedGrantIds: [], revokedDelegationIds: [], revokedDeviceIds: [] });
  const scope = { all: false, agentIds: ["fabric"], projectIds: [] };
  const grant = signAccessArtifact<AccessGrant>(owner, { protocol: ACCESS_PROTOCOL, kind: "grant", id: "grant-1", networkId: policy.networkId, issuerId: root.id,
    subjectId: subject.id, audience, revision: 1, issuedAt: now - 100, expiresAt: now + 50_000, revoked: false, scope, actions: ["discover", "message", "request", "read-own"] });
  const delegation = signAccessArtifact<AccessDelegation>(service, { protocol: ACCESS_PROTOCOL, kind: "delegation", id: "delegation-1", networkId: policy.networkId, principalId: subject.id,
    devicePublicKey: device.publicKey, audience, issuedAt: now - 100, expiresAt: now + 40_000, scope: { all: true, agentIds: [], projectIds: [] }, actions: ["discover", "message", "request", "read-own", "read-history", "admin"] });
  return { owner, service, member, admin, device, policy, grant, delegation, audience, now, subject, adminPrincipal };
}
