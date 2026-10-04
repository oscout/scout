import { randomUUID } from "node:crypto";
import { ACCESS_PROTOCOL, ACCESS_ACTIONS, ACCESS_POLICY_TTL_MS, ACCESS_DELEGATION_TTL_MS, ACCESS_ARTIFACT_MAX_BYTES, accessKeyId, accessRequestHash, signAccessArtifact, validateAccessPolicy, validateAccessRevocation, validateAccessScope,
  type AccessPolicy, type AccessGrant, type AccessDelegation, type AccessRevocation, type AccessScope, type AccessAction } from "@openscout/runtime/mesh/access";
import { GatewayError, exactFields, loadGatewayCredentials, record, type GatewayConfig, type GatewayUserConfig } from "./config.ts";
import type { GatewayBroker } from "./broker-client.ts";

// These objects stay in the server's one-use preview store. Only artifact,
// audience, warnings and a random preview identifier are exposed to the browser.
export type GatewayPreparedAction = {
  input: Record<string, unknown>; artifact: Record<string, unknown>; audience: string; warnings: string[];
  principalId: string; networkId: string; policyRevision: number; delegationHash: string; issuedAt: number; generatedId: string;
};
export type GatewayManagement = {
  prepare(user: GatewayUserConfig, input: Record<string, unknown>): Promise<GatewayPreparedAction>;
  execute(user: GatewayUserConfig, preview: GatewayPreparedAction): Promise<unknown>;
};
const deny = (): never => { throw new GatewayError(403, "management_not_authorized"); };
const requiredString = (value: unknown): string => { if (typeof value !== "string" || !value || value.length > 200) throw new GatewayError(400, "required_string"); return value; };
const artifactId = (value: unknown): string => { const id = requiredString(value); if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,199}$/.test(id)) throw new GatewayError(400, "invalid_identifier"); return id; };
const list = (value: unknown): Record<string, any>[] => { if (!Array.isArray(value)) throw new GatewayError(502, "invalid_network_status"); return value.map(record); };
const requestWarning = "A request grant may execute with the agent owner's OS authority. Use a separately isolated agent for restricted execution.";

export function createGatewayManage(config: GatewayConfig, broker: GatewayBroker, now: () => number = Date.now): GatewayManagement {
  async function prepare(user: GatewayUserConfig, input: Record<string, unknown>, fixed?: GatewayPreparedAction): Promise<GatewayPreparedAction> {
    const body = structuredClone(input);
    const schemas: Record<string, string[]> = {
      "grant.save": ["subjectId", "scope", "actions", "expiresAt", "id"], revoke: ["kind", "id", "principalId", "issuerId"],
      "device.approve": ["id", "devicePublicKey", "scope", "actions", "expiresAt"], "policy.submit": ["artifact"],
    };
    if (typeof body.action !== "string" || !Object.hasOwn(schemas, body.action)) throw new GatewayError(400, "unsupported_management_action");
    exactFields(body, ["action", ...schemas[body.action]!]);
    const credentials = loadGatewayCredentials(user, config.audience, now());
    const principalId = credentials.delegation.principalId;
    const status = record(await broker.call(user, { operation: "network.status" }));
    const network = record(status.network), viewer = record(status.viewer), viewerPrincipal = record(viewer.principal);
    if (viewerPrincipal.id !== principalId || network.id !== credentials.delegation.networkId) return deny();
    const networkId = requiredString(network.id), policy = status.policy as AccessPolicy | undefined;
    // v1 network identity is the root key identity. Recheck the fresh manifest
    // too: neither a changed role nor a misleading config can authorize a root.
    if (credentials.principal && (principalId === networkId || principalId === policy?.root.id)) throw new GatewayError(403, "root_signing_key_forbidden");
    if (body.action !== "policy.submit" && !credentials.principal) throw new GatewayError(403, "principal_signer_unavailable");
    if (credentials.principal && credentials.principal.principal.id !== viewerPrincipal.id) return deny();
    if (policy) { validateAccessPolicy(policy, now()); if (policy.networkId !== networkId || policy.revision !== network.revision) throw new GatewayError(502, "invalid_network_status"); }
    const issuedAt = fixed?.issuedAt ?? now(), generatedId = fixed?.generatedId ?? randomUUID();
    const result = (artifact: object): GatewayPreparedAction => ({ input: body, artifact: artifact as Record<string, unknown>, audience: config.audience,
      warnings: Array.isArray((artifact as any).actions) && (artifact as any).actions.includes("request") ? [requestWarning] : [],
      principalId, networkId, policyRevision: Number(network.revision), delegationHash: accessRequestHash(credentials.delegation), issuedAt, generatedId });
    // Collect only bounded, broker-filtered pages; never broaden the projection.
    const collections = ["grants", "delegations", "devices"] as const;
    const rows = Object.fromEntries(collections.map((key) => [key, list(status[key])])) as Record<typeof collections[number], Record<string, any>[]>;
    const resources = record(status.resources), agents = list(resources.agents), projects = list(resources.projects);
    let next = status.pagination ? record(status.pagination).nextOffset : null, previousOffset = 0;
    while (next !== null && next !== undefined) {
      if (!Number.isSafeInteger(next) || Number(next) <= previousOffset || Number(next) > 10_000) throw new GatewayError(502, "invalid_status_pagination");
      previousOffset = Number(next);
      const page = record(await broker.call(user, { operation: "network.status", offset: next }));
      if (record(page.network).id !== networkId || record(page.network).revision !== network.revision || record(record(page.viewer).principal).id !== principalId || page.canAdmin !== status.canAdmin) throw new GatewayError(409, "network_changed_refresh_preview");
      for (const key of collections) rows[key].push(...list(page[key]));
      const pageResources = record(page.resources); agents.push(...list(pageResources.agents)); projects.push(...list(pageResources.projects));
      next = record(page.pagination).nextOffset;
    }
    function scope(value: unknown, delegate = false): AccessScope {
      const selection = record(value); exactFields(selection, ["all", "agentIds", "projectIds"]);
      try { validateAccessScope(selection as AccessScope); } catch { throw new GatewayError(400, "invalid_scope"); }
      const selected = selection as AccessScope, source = credentials.delegation.scope;
      const agentIds = new Set(agents.map((a) => a.id)), projectIds = new Set(projects.map((p) => p.id));
      if ((selected.all && (!source.all || (!delegate && status.canAdmin !== true))) || selected.agentIds.some((id) => !agentIds.has(id)) || selected.projectIds.some((id) => !projectIds.has(id))) return deny();
      if (delegate && !source.all) {
        if (selected.all || selected.projectIds.some((id) => !source.projectIds.includes(id)) || selected.agentIds.some((id) => !source.agentIds.includes(id) && !source.projectIds.includes(agents.find((a) => a.id === id)?.projectId))) return deny();
      }
      return selected;
    }
    function actions(value: unknown, delegate = false): AccessAction[] {
      const allowed: readonly string[] = delegate ? ACCESS_ACTIONS : ["discover", "message", "request", "read-own"];
      if (!Array.isArray(value) || !value.length || value.some((a) => typeof a !== "string" || !allowed.includes(a)) || new Set(value).size !== value.length) throw new GatewayError(400, "invalid_actions");
      if (delegate && (value.some((a) => !credentials.delegation.actions.includes(a)) || (value.includes("admin") && (viewer.role !== "admin" || status.canAdmin !== true)))) return deny();
      return value as AccessAction[];
    }
    function expiry(value: unknown, ttl: number, delegate = false): number {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= now() || value > issuedAt + ttl || typeof network.expiresAt !== "number" || value > network.expiresAt
        || (delegate && value > credentials.delegation.expiresAt)) throw new GatewayError(400, "expiry_exceeds_authority");
      return value;
    }
    if (body.action === "policy.submit") {
      if (status.canAdmin !== true || !policy) return deny();
      const candidate = record(body.artifact) as AccessPolicy;
      if (Buffer.byteLength(JSON.stringify({ artifact: candidate })) > ACCESS_ARTIFACT_MAX_BYTES) throw new GatewayError(413, "artifact_too_large");
      try { validateAccessPolicy(candidate, now()); } catch { throw new GatewayError(400, "invalid_signed_policy"); }
      if (candidate.networkId !== networkId || candidate.root.id !== policy.root.id || candidate.root.publicKey !== policy.root.publicKey || candidate.revision <= policy.revision || candidate.issuedAt < policy.issuedAt) throw new GatewayError(409, "policy_must_advance_same_network");
      for (const key of ["revokedPrincipalIds", "revokedGrantIds", "revokedDeviceIds", "revokedDelegationIds"] as const) if (policy[key].some((id) => !candidate[key].includes(id))) throw new GatewayError(409, "policy_revocations_are_permanent");
      return result(candidate);
    }
    if (body.action === "grant.save") {
      if (status.canAdmin !== true || viewer.role !== "admin" || !policy) return deny();
      const subjectId = requiredString(body.subjectId);
      if (subjectId === principalId || policy.revokedPrincipalIds.includes(subjectId) || !policy.members.some((m) => m.principal.id === subjectId)) return deny();
      const existing = body.id === undefined ? undefined : rows.grants.find((g) => g.id === body.id && g.issuerId === principalId);
      if (body.id !== undefined && (!existing || existing.subjectId !== subjectId || existing.revoked || !Number.isSafeInteger(existing.revision))) return deny();
      return result({ protocol: ACCESS_PROTOCOL, kind: "grant", id: existing ? artifactId(existing.id) : generatedId,
        networkId, issuerId: principalId, subjectId, audience: config.audience, revision: existing ? Number(existing.revision) + 1 : 1,
        issuedAt, expiresAt: expiry(body.expiresAt, ACCESS_POLICY_TTL_MS), revoked: false, scope: scope(body.scope), actions: actions(body.actions) });
    }
    if (body.action === "device.approve") {
      const devicePublicKey = requiredString(body.devicePublicKey); let deviceId: string;
      try { deviceId = accessKeyId(devicePublicKey); } catch { throw new GatewayError(400, "invalid_device_key"); }
      if (deviceId === principalId || deviceId === config.audience || deviceId === networkId || devicePublicKey === credentials.device.publicKey) return deny();
      const id = body.id === undefined ? generatedId : artifactId(body.id);
      if (rows.delegations.some((d) => d.id === id && d.principalId === principalId)) throw new GatewayError(409, "delegation_id_already_exists");
      return result({ protocol: ACCESS_PROTOCOL, kind: "delegation", id, networkId, principalId, devicePublicKey, audience: config.audience, issuedAt,
        expiresAt: expiry(body.expiresAt, ACCESS_DELEGATION_TTL_MS, true), scope: scope(body.scope, true), actions: actions(body.actions, true) });
    }
    const id = artifactId(body.id), kind = body.kind;
    if (!["grant", "device", "delegation"].includes(String(kind))) throw new GatewayError(403, "root_policy_changes_require_cli_signed_policy");
    let own = false;
    if (kind === "grant") {
      if (body.issuerId !== undefined && body.issuerId !== principalId) return deny();
      own = rows.grants.some((g) => g.id === id && g.issuerId === principalId);
    } else if (kind === "delegation") {
      if (body.principalId !== undefined && body.principalId !== principalId) return deny();
      own = rows.delegations.some((d) => d.id === id && d.principalId === principalId);
    } else own = rows.devices.some((d) => d.keyId === id && d.principalId === principalId) || rows.delegations.some((d) => accessKeyId(d.devicePublicKey) === id && d.principalId === principalId);
    if (!own) return deny();
    return result({ protocol: ACCESS_PROTOCOL, kind: "revocation", networkId, issuerId: principalId, issuerPublicKey: credentials.principal!.identity.publicKey, targetKind: kind, targetId: id, issuedAt });
  }
  return {
    prepare: (user, body) => prepare(user, body),
    async execute(user, preview) {
      // Rebuild using only server-retained input and fixed preview ID/time, then
      // compare exact canonical bytes. Role, scope, membership, expiry, policy
      // revisions and rotated/revoked device authority are checked again.
      const fresh = await prepare(user, preview.input, preview);
      if (fresh.principalId !== preview.principalId || fresh.networkId !== preview.networkId || fresh.policyRevision !== preview.policyRevision
        || fresh.delegationHash !== preview.delegationHash || accessRequestHash(fresh.artifact) !== accessRequestHash(preview.artifact)) throw new GatewayError(409, "network_changed_refresh_preview");
      if (fresh.artifact.kind === "policy") return broker.submit(fresh.artifact);
      const credentials = loadGatewayCredentials(user, config.audience, now());
      if (!credentials.principal || credentials.principal.principal.id !== preview.principalId || preview.principalId === preview.networkId || accessRequestHash(credentials.delegation) !== preview.delegationHash) return deny();
      const artifact = signAccessArtifact<AccessGrant | AccessDelegation | AccessRevocation>(credentials.principal.identity, fresh.artifact as any);
      if (artifact.kind === "revocation") validateAccessRevocation(artifact, now());
      // All positive authority is independently validated by the receiving
      // broker; no local bearer or operator MAC credential exists in this path.
      if (artifact.kind === "delegation") return broker.call(user, { operation: "device.approve", artifact });
      return broker.submit(artifact);
    },
  };
}
