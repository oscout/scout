import { realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalJson, nodeKeyId } from "./node-identity.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { ACCESS_ARTIFACT_MAX_BYTES, accessMembership, accessRequestHash, accessRevocationTarget, prepareAccessEvaluation, MeshAccessError, validateAccessDelegation, validateAccessGrant, validateAccessPolicy, validateAccessRevocation,
  type AccessAction, type AccessDelegation, type AccessGrant, type AccessPolicy, type AccessProof, type AccessResource, type AccessRevocation, type AccessSubmission } from "./mesh-access.js";

export type AccessEnrollment = { networkId: string; agentIds: string[]; projects: { id: string; root: string; dev?: string; ino?: string }[] };
export const ACCESS_AUDIT_MAX_ROWS = 10_000;
export const ACCESS_ADMIN_AUDIT_MAX_ROWS = 1000;
export const ACCESS_UNKNOWN_REVOCATIONS_PER_ISSUER = 1000;
const grantKey = (networkId: string, issuerId: string, id: string) => accessRequestHash({ networkId, issuerId, id });
export class MeshAccessStore {
  private ready = false;
  private generation = 0;
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase, readonly audience: string,
    private readonly keyInUse: (id: string) => boolean = () => false) {}
  private get db(): ControlPlaneSqliteTransactionalDatabase {
    if (!this.ready) {
    this.database.exec(`CREATE TABLE IF NOT EXISTS mesh_access_policies (network_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_access_grants (id TEXT PRIMARY KEY, network_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_access_enrollments (network_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_access_sync (network_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_access_principals (network_id TEXT NOT NULL, principal_id TEXT NOT NULL, public_key TEXT NOT NULL, PRIMARY KEY(network_id,principal_id));
      CREATE TABLE IF NOT EXISTS mesh_access_revocations (network_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, expires_at INTEGER, json TEXT NOT NULL, unknown_target INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(network_id,kind,id));
      CREATE TABLE IF NOT EXISTS mesh_access_delegations (network_id TEXT NOT NULL, principal_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(network_id,principal_id,id));
      CREATE TABLE IF NOT EXISTS mesh_access_devices (key_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, principal_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mesh_access_denials (network_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(network_id,kind,id));
      CREATE TABLE IF NOT EXISTS mesh_access_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, network_id TEXT, principal_id TEXT, device_id TEXT, action TEXT NOT NULL, resource TEXT, decision TEXT NOT NULL, revision INTEGER, retention_class TEXT NOT NULL DEFAULT 'administration');
      CREATE TABLE IF NOT EXISTS mesh_access_work (id TEXT PRIMARY KEY, network_id TEXT NOT NULL, principal_id TEXT NOT NULL, agent_id TEXT NOT NULL, project_id TEXT, request_hash TEXT NOT NULL);`);
    const legacyDenials = this.database.query<{ id: string }>("SELECT id FROM mesh_access_denials WHERE kind IN ('grant','delegation')").all();
    if (legacyDenials.some((row) => !/^[a-f0-9]{64}:[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,199}$/.test(row.id)))
      throw new MeshAccessError("access_store_migration_required", "legacy grant/delegation denials require explicit offline namespace migration; scoped access is disabled", 503);
    if (!this.database.query<{ name: string }>("PRAGMA table_info(mesh_access_revocations)").all().some((c) => c.name === "unknown_target"))
      this.database.exec("ALTER TABLE mesh_access_revocations ADD COLUMN unknown_target INTEGER NOT NULL DEFAULT 0");
    // Earlier signed device withdrawals were global. Their signed issuer supplies the safe principal namespace.
    this.database.transaction(() => {
      for (const row of this.database.query<{ network_id: string; id: string; json: string }>("SELECT network_id,id,json FROM mesh_access_revocations WHERE kind='device'").all()) {
        const artifact = JSON.parse(row.json) as AccessRevocation;
        validateAccessRevocation(artifact);
        const target = accessRevocationTarget(artifact.issuerId, artifact.targetId);
        if (artifact.targetKind !== "device" || artifact.networkId !== row.network_id || !/^[a-f0-9]{64}$/.test(artifact.targetId)
          || (row.id !== artifact.targetId && row.id !== target))
          throw new MeshAccessError("access_store_migration_required", "invalid signed device revocation requires explicit offline migration", 503);
        if (row.id !== target) this.database.query("UPDATE mesh_access_revocations SET id=?1 WHERE network_id=?2 AND kind='device' AND id=?3").run(target, row.network_id, row.id);
      }
    })();
    if (!this.database.query<{ name: string }>("PRAGMA table_info(mesh_access_audit)").all().some((c) => c.name === "retention_class")) {
      this.database.exec("ALTER TABLE mesh_access_audit ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'administration'");
      this.database.exec("UPDATE mesh_access_audit SET retention_class='decision' WHERE principal_id IS NOT NULL AND resource <> 'administration'");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS mesh_access_audit_retention ON mesh_access_audit(retention_class,id)");
    for (const [kind, cap] of [["decision", ACCESS_AUDIT_MAX_ROWS], ["administration", ACCESS_ADMIN_AUDIT_MAX_ROWS]] as const)
      this.database.query("DELETE FROM mesh_access_audit WHERE retention_class=?1 AND id <= (SELECT id FROM mesh_access_audit WHERE retention_class=?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)").run(kind, cap);
    // Seed signer bindings when opening a database written before signed revocations existed.
    for (const row of this.database.query<{ json: string }>("SELECT json FROM mesh_access_policies").all()) {
      const policy = JSON.parse(row.json) as AccessPolicy;
      for (const principal of [policy.root, ...policy.members.map((m) => m.principal)])
        this.database.query("INSERT OR IGNORE INTO mesh_access_principals(network_id,principal_id,public_key) VALUES(?1,?2,?3)")
          .run(policy.networkId, principal.id, principal.publicKey);
    }
    // Rewrite pre-foundation storage keys and payload-bearing idempotency rows in place.
    for (const row of this.database.query<{ id: string; json: string }>("SELECT id,json FROM mesh_access_grants").all()) {
      const grant = JSON.parse(row.json) as AccessGrant;
      const key = grantKey(grant.networkId, grant.issuerId, grant.id);
      if (row.id !== key) this.database.query("UPDATE mesh_access_grants SET id=?1 WHERE id=?2").run(key, row.id);
    }
    if (this.database.query<{ name: string }>("PRAGMA table_info(mesh_access_work)").all().some((c) => c.name === "request_json"))
      this.database.exec("ALTER TABLE mesh_access_work RENAME COLUMN request_json TO request_hash");
    for (const row of this.database.query<{ id: string; request_hash: string }>("SELECT id,request_hash FROM mesh_access_work").all()) {
      if (!/^[a-f0-9]{64}$/.test(row.request_hash))
        this.database.query("UPDATE mesh_access_work SET request_hash=?1 WHERE id=?2").run(accessRequestHash(JSON.parse(row.request_hash)), row.id);
    }
    this.ready = true;
    }
    return this.database;
  }
  /** Incompatible or inaccessible scoped state must never advertise a working capability. */
  healthy(): boolean {
    try { return this.db.query<{ ok: number }>("SELECT 1 AS ok").get()?.ok === 1; } catch { return false; }
  }
  private load<T>(table: string, key: string, id: string): T | undefined {
    const row = this.db.query<{ json: string }>(`SELECT json FROM ${table} WHERE ${key}=?1`).get(id);
    return row ? JSON.parse(row.json) as T : undefined;
  }
  policy(networkId: string): AccessPolicy | undefined { return this.load("mesh_access_policies", "network_id", networkId); }
  enrollment(networkId: string): AccessEnrollment | undefined { return this.load("mesh_access_enrollments", "network_id", networkId); }
  grants(networkId: string): AccessGrant[] {
    return this.db.query<{ json: string }>("SELECT json FROM mesh_access_grants WHERE network_id=?1").all(networkId).map((r) => JSON.parse(r.json));
  }
  knownDevice(id: string): boolean { return Boolean(this.db.query("SELECT key_id FROM mesh_access_devices WHERE key_id=?1").get(id)); }
  /** Historical principal keys remain reserved after policy expiry or removal. */
  knownPrincipal(id: string): boolean { return Boolean(this.db.query("SELECT principal_id FROM mesh_access_principals WHERE principal_id=?1 LIMIT 1").get(id)); }
  /** Carrier identity grants no authority; only artifact signatures may change installed trust. */
  submitArtifact(artifact: AccessSubmission, now = Date.now()): void {
    if (!artifact || Buffer.byteLength(JSON.stringify(artifact), "utf8") > ACCESS_ARTIFACT_MAX_BYTES)
      throw new MeshAccessError("invalid_access_artifact", "access artifact exceeds size limit", 400);
    switch (artifact.kind) {
      case "policy": return this.importPolicy(artifact, false, now);
      case "grant": return this.importGrant(artifact, now);
      case "revocation": return this.importRevocation(artifact, now);
      default: throw new MeshAccessError("invalid_access_artifact", "unsupported access artifact", 400);
    }
  }
  importPolicy(policy: AccessPolicy, allowNew: boolean, now = Date.now()): void {
    validateAccessPolicy(policy, now);
    if ([policy.root, ...policy.members.map((m) => m.principal)].some((p) => p.id === this.audience || this.keyInUse(p.id) || this.knownDevice(p.id)))
      throw new MeshAccessError("key_in_use", "principal keys must be separate from broker node, scoped device, legacy peer and guest keys");
    const installed = this.policy(policy.networkId);
    if (installed && canonicalJson(installed) === canonicalJson(policy)) return;
    this.db.transaction(() => {
      const old = this.policy(policy.networkId);
      if (!old && !allowNew) throw new MeshAccessError("network_not_enrolled", "new network trust requires a local operator");
      if (old) {
        if (policy.revision < old.revision || policy.issuedAt < old.issuedAt || (policy.revision === old.revision && canonicalJson(policy) !== canonicalJson(old)))
          throw new MeshAccessError("policy_rollback", "policy revision is stale or conflicts", 409);
        for (const field of ["revokedPrincipalIds", "revokedGrantIds", "revokedDelegationIds", "revokedDeviceIds"] as const) {
          if (old[field].some((id) => !policy[field].includes(id))) throw new MeshAccessError("revocation_rollback", "revocation tombstones cannot be removed", 409);
        }
      }
      // Preserve historical signer bindings so removed principals can still withdraw their own access material.
      for (const knownPolicy of [old, policy]) {
        if (!knownPolicy) continue;
        for (const principal of [knownPolicy.root, ...knownPolicy.members.map((m) => m.principal)])
          this.db.query("INSERT OR IGNORE INTO mesh_access_principals(network_id,principal_id,public_key) VALUES(?1,?2,?3)")
            .run(policy.networkId, principal.id, principal.publicKey);
      }
      this.db.query("INSERT INTO mesh_access_policies(network_id,json) VALUES(?1,?2) ON CONFLICT(network_id) DO UPDATE SET json=excluded.json").run(policy.networkId, JSON.stringify(policy));
      this.db.query("INSERT INTO mesh_access_sync(network_id,at) VALUES(?1,?2) ON CONFLICT(network_id) DO UPDATE SET at=excluded.at").run(policy.networkId, now);
      this.generation++;
      this.audit(undefined, "policy.import", policy.networkId, "allow", policy.revision, now);
    })();
  }
  importGrant(grant: AccessGrant, now = Date.now()): void {
    const installed = grant && this.load<AccessGrant>("mesh_access_grants", "id", grantKey(grant.networkId, grant.issuerId, grant.id));
    if (installed && canonicalJson(installed) === canonicalJson(grant)) return;
    const policy = this.policy(grant.networkId);
    if (!policy) throw new MeshAccessError("unknown_network", "network is not installed");
    validateAccessGrant(grant, policy, now);
    if (grant.audience !== this.audience) throw new MeshAccessError("wrong_audience", "grant is for another broker");
    if (this.denied(grant.networkId, "grant", accessRevocationTarget(grant.issuerId, grant.id)) || policy.revokedGrantIds.includes(accessRevocationTarget(grant.issuerId, grant.id)))
      throw new MeshAccessError("grant_revoked", "revoked grants cannot be reinstalled", 409);
    this.db.transaction(() => {
      const old = this.load<AccessGrant>("mesh_access_grants", "id", grantKey(grant.networkId, grant.issuerId, grant.id));
      if (old && (old.networkId !== grant.networkId || old.issuerId !== grant.issuerId || old.subjectId !== grant.subjectId
        || old.audience !== grant.audience || grant.revision < old.revision || (old.revoked && !grant.revoked)
        || (old.revision === grant.revision && canonicalJson(old) !== canonicalJson(grant)))) {
        throw new MeshAccessError("grant_conflict", "grant binding/revision conflicts or attempts resurrection", 409);
      }
      this.db.query("INSERT INTO mesh_access_grants(id,network_id,json) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
        .run(grantKey(grant.networkId, grant.issuerId, grant.id), grant.networkId, JSON.stringify(grant));
      this.generation++;
      this.audit(undefined, "grant.import", grant.id, "allow", policy.revision, now);
    })();
  }
  importRevocation(revocation: AccessRevocation, now = Date.now()): void {
    validateAccessRevocation(revocation, now);
    const policy = this.policy(revocation.networkId);
    if (!policy) throw new MeshAccessError("unknown_network", "network is not installed");
    const historical = this.db.query<{ public_key: string }>("SELECT public_key FROM mesh_access_principals WHERE network_id=?1 AND principal_id=?2")
      .get(revocation.networkId, revocation.issuerId);
    const current = [policy.root, ...policy.members.map((m) => m.principal)].find((p) => p.id === revocation.issuerId);
    if ((historical?.public_key ?? current?.publicKey) !== revocation.issuerPublicKey)
      throw new MeshAccessError("revocation_authority", "revocation signer is not a known network principal");
    const target = accessRevocationTarget(revocation.issuerId, revocation.targetId);
    let expiresAt: number | null = null;
    let unknownTarget = false;
    if (revocation.targetKind === "grant") {
      const grant = this.load<AccessGrant>("mesh_access_grants", "id", grantKey(revocation.networkId, revocation.issuerId, revocation.targetId));
      if (!grant) throw new MeshAccessError("revocation_authority", "signer may revoke only its own known grant");
      expiresAt = grant.expiresAt;
    } else if (revocation.targetKind === "delegation") {
      const row = this.db.query<{ json: string }>("SELECT json FROM mesh_access_delegations WHERE network_id=?1 AND principal_id=?2 AND id=?3")
        .get(revocation.networkId, revocation.issuerId, revocation.targetId);
      unknownTarget = !row;
      expiresAt = row ? (JSON.parse(row.json) as AccessDelegation).expiresAt : null;
    } else {
      if (!/^[a-f0-9]{64}$/.test(revocation.targetId)) throw new MeshAccessError("invalid_revocation", "device target must be a canonical key ID", 400);
      const device = this.db.query<{ principal_id: string }>("SELECT principal_id FROM mesh_access_devices WHERE key_id=?1").get(revocation.targetId);
      const recorded = this.db.query<{ json: string }>("SELECT json FROM mesh_access_delegations WHERE network_id=?1 AND principal_id=?2")
        .all(revocation.networkId, revocation.issuerId).some((row) => nodeKeyId((JSON.parse(row.json) as AccessDelegation).devicePublicKey) === revocation.targetId);
      unknownTarget = device?.principal_id !== revocation.issuerId || !recorded;
    }
    this.db.transaction(() => {
      // A tombstone already present is semantically immutable, even if its issuer re-signs it with a later date.
      if (this.db.query("SELECT id FROM mesh_access_revocations WHERE network_id=?1 AND kind=?2 AND id=?3")
        .get(revocation.networkId, revocation.targetKind, target)) return;
      if (unknownTarget) {
        const count = this.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_revocations WHERE kind=?1 AND unknown_target=1 AND id LIKE ?2")
          .get(revocation.targetKind, `${revocation.issuerId}:%`)!.n;
        if (count >= ACCESS_UNKNOWN_REVOCATIONS_PER_ISSUER)
          throw new MeshAccessError("revocation_limit", "unknown-target revocation limit reached for this issuer and target kind", 429);
      }
      // Permanent principal/device pairs cannot affect another principal's use of that key.
      // Expiry-backed grant/delegation tombstones are retained to prevent renewal of revoked IDs.
      this.db.query("INSERT INTO mesh_access_revocations(network_id,kind,id,expires_at,json,unknown_target) VALUES(?1,?2,?3,?4,?5,?6)")
        .run(revocation.networkId, revocation.targetKind, target, expiresAt, JSON.stringify(revocation), unknownTarget ? 1 : 0);
      this.generation++;
      // Unseen targets are member-controlled identifiers; their signed tombstones are the durable record.
      // They must not consume administration retention and evict owner policy/grant history.
      if (!unknownTarget) {
        const role = accessMembership(policy, revocation.issuerId)?.role;
        // A member can register then withdraw arbitrary own certificates. Keep
        // those verified signer events out of privileged administration history.
        const signer = role === "owner" || role === "admin" ? undefined : { networkId: revocation.networkId, principalId: revocation.issuerId };
        this.audit(signer, "revocation.import", `${revocation.networkId}:${revocation.targetKind}:${target}`, "allow", policy.revision, now);
      }
    })();
  }
  verifyDelegation(delegation: AccessDelegation, now = Date.now()): AccessProof {
    const policy = this.policy(delegation?.networkId);
    if (!policy) throw new MeshAccessError("access_denied", "access denied");
    const proof = validateAccessDelegation(delegation, policy, this.audience, now);
    if (proof.deviceId === this.audience || this.keyInUse(proof.deviceId)
      || this.knownPrincipal(proof.deviceId))
      throw new MeshAccessError("key_in_use", "scoped devices must use keys separate from broker, principal, legacy peer and guest keys");
    if (this.denied(proof.networkId, "device", proof.deviceId) || this.denied(proof.networkId, "device", accessRevocationTarget(proof.principalId, proof.deviceId))
      || this.denied(proof.networkId, "principal", proof.principalId)
      || this.denied(proof.networkId, "delegation", accessRevocationTarget(proof.principalId, delegation.id))) throw new MeshAccessError("access_denied", "access denied");
    const owner = this.db.query<{ principal_id: string }>("SELECT principal_id FROM mesh_access_devices WHERE key_id=?1").get(proof.deviceId);
    if (owner && owner.principal_id !== proof.principalId) throw new MeshAccessError("device_principal_conflict", "each device credential belongs to one principal; use a fresh service device key", 409);
    const known = this.db.query<{ json: string }>("SELECT json FROM mesh_access_delegations WHERE network_id=?1 AND principal_id=?2 AND id=?3")
      .all(proof.networkId, proof.principalId, delegation.id);
    if (known.some((row) => canonicalJson(JSON.parse(row.json)) !== canonicalJson(delegation))) throw new MeshAccessError("delegation_conflict", "delegation IDs are immutable; renew with a new ID", 409);
    return proof;
  }
  /** Explicit local import records signed material, never proof of device-key possession. */
  importDelegation(delegation: AccessDelegation, now = Date.now()): AccessProof {
    const proof = this.verifyDelegation(delegation, now);
    if (this.db.query("SELECT id FROM mesh_access_delegations WHERE network_id=?1 AND principal_id=?2 AND id=?3")
      .get(proof.networkId, proof.principalId, delegation.id)) return proof;
    this.db.query("INSERT OR IGNORE INTO mesh_access_delegations(network_id,principal_id,id,json) VALUES(?1,?2,?3,?4)")
      .run(proof.networkId, proof.principalId, delegation.id, JSON.stringify(delegation));
    this.generation++;
    this.audit(proof, "delegation.import", delegation.id, "allow", this.policy(proof.networkId)?.revision, now);
    return proof;
  }
  /** Invoke only after successful v2-scoped transport signature/nonce verification. */
  acceptDelegation(delegation: AccessDelegation, now = Date.now()): AccessProof {
    return this.db.transaction(() => {
      const proof = this.importDelegation(delegation, now);
      this.db.query("INSERT OR IGNORE INTO mesh_access_devices(key_id,public_key,principal_id) VALUES(?1,?2,?3)")
        .run(proof.deviceId, delegation.devicePublicKey, proof.principalId);
      return proof;
    })();
  }
  enroll(input: AccessEnrollment, registeredRoots: Set<string>, registeredAgentIds: Set<string>): AccessEnrollment {
    if (!this.policy(input.networkId)) throw new MeshAccessError("unknown_network", "import policy before enrolling resources", 400);
    if (!Array.isArray(input.agentIds) || !Array.isArray(input.projects) || input.agentIds.length > 1000 || input.projects.length > 1000)
      throw new MeshAccessError("invalid_enrollment", "invalid resource enrollment", 400);
    if (input.agentIds.some((id) => !registeredAgentIds.has(id))) throw new MeshAccessError("invalid_enrollment", "only registered local agents may be enrolled", 400);
    const previous = this.enrollment(input.networkId);
    const projects = input.projects.map((project) => {
      const root = realpathSync(project.root);
      if (root !== project.root || !registeredRoots.has(root)) throw new MeshAccessError("invalid_enrollment", "project must be an exact canonical registered root", 400);
      const info = statSync(root, { bigint: true });
      if (!info.isDirectory()) throw new MeshAccessError("invalid_enrollment", "project root must be a directory", 400);
      const dev = info.dev.toString(), ino = info.ino.toString();
      const existing = previous?.projects.find((p) => p.root === root && p.dev === dev && p.ino === ino);
      if (project.id && project.id !== existing?.id) throw new MeshAccessError("invalid_enrollment", "project ID must match its existing filesystem identity", 400);
      return { id: existing?.id ?? `project.${randomUUID()}`, root, dev, ino };
    });
    const enrollment = { networkId: input.networkId, agentIds: [...new Set(input.agentIds)], projects };
    const others = this.db.query<{ json: string }>("SELECT json FROM mesh_access_enrollments WHERE network_id<>?1").all(input.networkId)
      .map((row) => JSON.parse(row.json) as AccessEnrollment);
    if (others.some((other) => other.agentIds.some((id) => enrollment.agentIds.includes(id))
      || other.projects.some((project) => projects.some((p) => p.id === project.id || p.root === project.root))))
      throw new MeshAccessError("resource_network_conflict", "a resource may be enrolled in only one network", 409);
    if (previous && canonicalJson(previous) === canonicalJson(enrollment)) return previous;
    this.db.query("INSERT INTO mesh_access_enrollments(network_id,json) VALUES(?1,?2) ON CONFLICT(network_id) DO UPDATE SET json=excluded.json").run(input.networkId, JSON.stringify(enrollment));
    this.generation++;
    this.audit(undefined, "resources.enroll", input.networkId, "allow");
    return enrollment;
  }
  resource(networkId: string, agentId: string, currentProjectRoot?: string): AccessResource | undefined {
    const enrolled = this.enrollment(networkId);
    if (!enrolled) return undefined;
    let projectId: string | undefined;
    let canonicalProjectRoot: string | undefined;
    if (currentProjectRoot) {
      try {
        const canonical = realpathSync(currentProjectRoot);
        canonicalProjectRoot = canonical;
        // Renames/deletions or aliases cannot move enrolled authority.
        if (canonical === currentProjectRoot) {
          const info = statSync(canonical, { bigint: true });
          projectId = enrolled.projects.find((p) => p.root === canonical && p.dev === info.dev.toString() && p.ino === info.ino.toString())?.id;
        }
      } catch { /* stale project supplies no project authority */ }
    }
    // An agent explicitly enrolled elsewhere or covered by another network's project must never gain two roots.
    const conflict = this.db.query<{ json: string }>("SELECT json FROM mesh_access_enrollments WHERE network_id<>?1").all(networkId)
      .some((row) => {
        const other = JSON.parse(row.json) as AccessEnrollment;
        return other.agentIds.includes(agentId) || Boolean(canonicalProjectRoot && other.projects.some((p) => p.root === canonicalProjectRoot));
      });
    if (conflict) return undefined;
    return enrolled.agentIds.includes(agentId) || projectId ? { agentId, ...(projectId ? { projectId } : {}) } : undefined;
  }
  /** Request-local evaluation; imports/revocations and expiry invalidate captured authority. */
  prepareAccess(proof: AccessProof, now?: number) {
    let generation = -1;
    let refreshAt = 0;
    let prepared: ReturnType<typeof prepareAccessEvaluation> | undefined;
    const refresh = () => {
      const at = now ?? Date.now();
      if (generation === this.generation && refreshAt > at) return prepared;
      prepared = undefined;
      generation = this.generation;
      refreshAt = at + 15_000;
      try {
        this.verifyDelegation(proof.delegation, at);
        const policy = this.policy(proof.networkId)!;
        const denials = this.db.query<{ kind: string; id: string }>("SELECT kind,id FROM mesh_access_denials WHERE network_id=?1 UNION SELECT kind,id FROM mesh_access_revocations WHERE network_id=?1").all(proof.networkId);
        const blocked = new Set(denials.map((d) => `${d.kind}:${d.id}`));
        prepared = prepareAccessEvaluation({ policy, proof, audience: this.audience, now: at,
          grants: this.grants(proof.networkId).filter((g) => !blocked.has(`grant:${accessRevocationTarget(g.issuerId, g.id)}`) && !blocked.has(`principal:${g.issuerId}`)) });
        refreshAt = prepared.expiresAt;
      } catch { /* Invalid or expired snapshots deny all actions. */ }
      return prepared;
    };
    refresh();
    return { allowed: (action: AccessAction, resource: AccessResource) => refresh()?.allowed(action, resource) ?? false,
      admin: () => refresh()?.admin() ?? false };
  }
  allowed(proof: AccessProof, action: AccessAction, resource: AccessResource, now = Date.now(), audit = true): boolean {
    const allowed = this.prepareAccess(proof, now).allowed(action, resource);
    if (audit) this.audit(proof, action, resource.agentId, allowed ? "allow" : "deny", this.policy(proof.networkId)?.revision, now);
    return allowed;
  }
  admin(proof: AccessProof, now = Date.now()): boolean { return this.prepareAccess(proof, now).admin(); }
  revoke(networkId: string, kind: string, id: string, now = Date.now()): void {
    if (!["device", "principal", "delegation", "grant"].includes(kind) || typeof id !== "string" || !id || id.length > 265)
      throw new MeshAccessError("invalid_revocation", "invalid revocation selector", 400);
    if ((kind === "grant" || kind === "delegation") && !/^[a-f0-9]{64}:[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,199}$/.test(id))
      throw new MeshAccessError("invalid_revocation", "grant/delegation selector requires issuer/principal key ID namespace", 400);
    if (this.policy(networkId)?.root.id === id && kind === "principal") throw new MeshAccessError("last_owner", "root owner removal requires an unsupported ownership transfer");
    if (this.db.query("SELECT id FROM mesh_access_denials WHERE network_id=?1 AND kind=?2 AND id=?3").get(networkId, kind, id)) return;
    this.db.query("INSERT OR IGNORE INTO mesh_access_denials(network_id,kind,id,at) VALUES(?1,?2,?3,?4)").run(networkId, kind, id, now);
    this.generation++;
    this.audit(undefined, "revoke", `${kind}:${id}`, "allow", undefined, now);
  }
  unrevoke(networkId: string, kind: string, id: string, now = Date.now()): void {
    if (!this.db.query("SELECT id FROM mesh_access_denials WHERE network_id=?1 AND kind=?2 AND id=?3").get(networkId, kind, id)) return;
    this.db.query("DELETE FROM mesh_access_denials WHERE network_id=?1 AND kind=?2 AND id=?3").run(networkId, kind, id);
    this.generation++;
    this.audit(undefined, "local-deny.remove", `${kind}:${id}`, "allow", undefined, now);
  }
  private denied(networkId: string, kind: string, id: string): boolean {
    return Boolean(this.db.query("SELECT id FROM mesh_access_denials WHERE network_id=?1 AND kind=?2 AND id=?3 UNION SELECT id FROM mesh_access_revocations WHERE network_id=?1 AND kind=?2 AND id=?3").get(networkId, kind, id));
  }
  audit(proof: { networkId: string; principalId: string; deviceId?: string } | undefined, action: string, resource: string, decision: string, revision?: number, now = Date.now()): void {
    const retentionClass = proof && resource !== "administration" ? "decision" : "administration";
    this.db.query("INSERT INTO mesh_access_audit(at,network_id,principal_id,device_id,action,resource,decision,revision,retention_class) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")
      .run(now, proof?.networkId ?? null, proof?.principalId ?? null, proof?.deviceId ?? null, action.slice(0, 64), resource.slice(0, 512), decision.slice(0, 64), revision ?? null, retentionClass);
    this.db.query("DELETE FROM mesh_access_audit WHERE retention_class=?1 AND id <= (SELECT id FROM mesh_access_audit WHERE retention_class=?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)")
      .run(retentionClass, retentionClass === "decision" ? ACCESS_AUDIT_MAX_ROWS : ACCESS_ADMIN_AUDIT_MAX_ROWS);
  }
  /** Unverified traffic must never create durable records; ingress owns throttled diagnostic logging. */
  auditDenied(_deviceId: string | undefined, _action: string, _resource: string): void {}
  status() {
    return { protocol: "scout-access/1", audience: this.audience,
      auditRetention: { decision: ACCESS_AUDIT_MAX_ROWS, administration: ACCESS_ADMIN_AUDIT_MAX_ROWS },
      policies: this.db.query<{ json: string }>("SELECT json FROM mesh_access_policies").all().map((r) => JSON.parse(r.json)),
      enrollments: this.db.query<{ json: string }>("SELECT json FROM mesh_access_enrollments").all().map((r) => JSON.parse(r.json)),
      grants: this.db.query<{ json: string }>("SELECT json FROM mesh_access_grants").all().map((r) => JSON.parse(r.json)),
      revocations: this.db.query("SELECT network_id AS networkId,kind,id,at FROM mesh_access_denials").all(),
      signedRevocations: this.db.query<{ json: string; expires_at: number | null }>("SELECT json,expires_at FROM mesh_access_revocations").all()
        .map((row) => ({ artifact: JSON.parse(row.json) as AccessRevocation, targetExpiresAt: row.expires_at })),
      policyFreshness: this.db.query<{ networkId: string; lastReceivedAt: number }>("SELECT network_id AS networkId,at AS lastReceivedAt FROM mesh_access_sync").all()
        .map((row) => ({ ...row, lastRootIssuedAt: this.policy(row.networkId)!.issuedAt, expiresAt: this.policy(row.networkId)!.expiresAt })),
      delegations: this.db.query<{ json: string }>("SELECT json FROM mesh_access_delegations").all().map((r) => JSON.parse(r.json)),
      devices: this.db.query("SELECT key_id AS keyId,public_key AS publicKey,principal_id AS principalId FROM mesh_access_devices").all(),
      audit: this.db.query("SELECT * FROM mesh_access_audit ORDER BY id DESC LIMIT 100").all(),
      auditAdministration: this.db.query("SELECT * FROM mesh_access_audit WHERE retention_class='administration' ORDER BY id DESC LIMIT 100").all() };
  }
  /** Remote projection reads only this network/subject and at most one bounded page. */
  scopedStatusRows(networkId: string, principalId: string | null, offset: number) {
    const jsonRows = <T,>(sql: string) => this.db.query<{ json: string }>(sql).all(networkId, principalId, offset).map((r) => JSON.parse(r.json) as T);
    return {
      grants: jsonRows<AccessGrant>("SELECT json FROM mesh_access_grants WHERE network_id=?1 AND (?2 IS NULL OR json_extract(json,'$.subjectId')=?2) ORDER BY id LIMIT 101 OFFSET ?3"),
      delegations: jsonRows<AccessDelegation>("SELECT json FROM mesh_access_delegations WHERE network_id=?1 AND (?2 IS NULL OR principal_id=?2) ORDER BY principal_id,id LIMIT 101 OFFSET ?3"),
      devices: this.db.query<{ keyId: string; publicKey: string; principalId: string }>("SELECT d.key_id AS keyId,d.public_key AS publicKey,d.principal_id AS principalId FROM mesh_access_devices d WHERE (?2 IS NULL OR d.principal_id=?2) AND EXISTS(SELECT 1 FROM mesh_access_delegations c WHERE c.network_id=?1 AND c.principal_id=d.principal_id AND json_extract(c.json,'$.devicePublicKey')=d.public_key) ORDER BY d.key_id LIMIT 101 OFFSET ?3").all(networkId, principalId, offset),
      signedRevocations: jsonRows<AccessRevocation>("SELECT json FROM mesh_access_revocations WHERE network_id=?1 AND (?2 IS NULL OR json_extract(json,'$.issuerId')=?2) ORDER BY kind,id LIMIT 101 OFFSET ?3").map((artifact) => ({ artifact })),
      localDenials: principalId === null ? this.db.query("SELECT network_id AS networkId,kind,id,at FROM mesh_access_denials WHERE network_id=?1 ORDER BY kind,id LIMIT 101 OFFSET ?2").all(networkId, offset) : [],
      lastReceivedAt: this.db.query<{ at: number }>("SELECT at FROM mesh_access_sync WHERE network_id=?1").get(networkId)?.at,
    };
  }
  ownWork(networkId: string, principalId: string) {
    return this.db.query<{ id: string; network_id: string; principal_id: string; agent_id: string; project_id: string | null }>(
      "SELECT id,network_id,principal_id,agent_id,project_id FROM mesh_access_work WHERE network_id=?1 AND principal_id=?2 ORDER BY rowid DESC LIMIT 100").all(networkId, principalId);
  }
  recordWork(id: string, proof: AccessProof, resource: AccessResource, request: object): void {
    this.db.query("INSERT OR IGNORE INTO mesh_access_work(id,network_id,principal_id,agent_id,project_id,request_hash) VALUES(?1,?2,?3,?4,?5,?6)")
      .run(id, proof.networkId, proof.principalId, resource.agentId, resource.projectId ?? null, accessRequestHash(request));
  }
  work(id: string) {
    return this.db.query<{ network_id: string; principal_id: string; agent_id: string; project_id: string | null; request_hash: string }>("SELECT * FROM mesh_access_work WHERE id=?1").get(id);
  }
}
