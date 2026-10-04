import { constants, closeSync, fstatSync, openSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { createPrivateKey, createPublicKey, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { accessKeyId, ACCESS_PROTOCOL, ACCESS_CLOCK_SKEW_MS, ACCESS_DELEGATION_TTL_MS, validateAccessScope, type AccessDelegation, type AccessPrincipal } from "@openscout/runtime/mesh/access";
import type { NodeIdentity } from "@openscout/runtime/mesh/node-identity";

export type GatewayUserConfig = { login: string; passwordHash: string; deviceFile: string; delegationFile: string; principalFile?: string };
export type GatewayConfig = {
  privateDirectory: string; isolation: { gatewayUid: number; brokerUid: number; agentUids: number[] }; origin: string; listenHost: string; brokerUrl: string; audience: string; tlsPin?: string;
  tls?: { cert: string; key: string }; users: GatewayUserConfig[]; sessionTtlSeconds: number; idleTtlSeconds: number;
};
export type GatewayCredentials = { device: NodeIdentity; delegation: AccessDelegation; principal?: { identity: NodeIdentity; principal: AccessPrincipal } };
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const isLoopbackHost = (host: string) => ["127.0.0.1", "[::1]", "::1", "localhost"].includes(host);
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(400, "invalid_object");
  return value as Record<string, unknown>;
}
export function exactFields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new GatewayError(400, "unsupported_field");
}
export function privateText(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    return readFileSync(fd, "utf8");
  } catch { throw new GatewayError(500, "private_file_requires_owner_only_regular_file"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function privateJson(path: string): Record<string, unknown> {
  const text = privateText(path);
  try { return record(JSON.parse(text)); } catch { throw new GatewayError(500, "invalid_private_json"); }
}
function identity(value: unknown): NodeIdentity {
  const item = record(value);
  exactFields(item, ["version", "publicKey", "privateKey", "createdAt"]);
  try {
    if (item.version !== 1 || typeof item.publicKey !== "string" || typeof item.privateKey !== "string" || !Number.isSafeInteger(item.createdAt)) throw new Error();
    const key = createPrivateKey({ key: Buffer.from(item.privateKey, "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519" || createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") !== item.publicKey) throw new Error();
    accessKeyId(item.publicKey);
    return item as NodeIdentity;
  } catch { throw new GatewayError(500, "invalid_private_identity"); }
}
export function loadGatewayCredentials(user: GatewayUserConfig, audience: string, now = Date.now(), forbiddenRootIds?: ReadonlySet<string>): GatewayCredentials {
  const item = privateJson(user.delegationFile);
  exactFields(item, ["protocol", "kind", "id", "networkId", "principalId", "devicePublicKey", "audience", "issuedAt", "expiresAt", "scope", "actions", "signature"]);
  const delegation = item as AccessDelegation;
  const deviceFile = privateJson(user.deviceFile);
  exactFields(deviceFile, ["protocol", "kind", "identity"]);
  if (deviceFile.protocol !== ACCESS_PROTOCOL || deviceFile.kind !== "private-device") throw new GatewayError(500, "expected_private_device");
  const deviceId = accessKeyId(record(deviceFile.identity).publicKey);
  if (deviceId === delegation.networkId || forbiddenRootIds?.has(deviceId)) throw new GatewayError(500, "root_signing_key_forbidden");
  if (deviceId === delegation.principalId || deviceId === audience) throw new GatewayError(500, "device_key_must_be_separate");
  const device = identity(deviceFile.identity);
  if (delegation.protocol !== ACCESS_PROTOCOL || delegation.kind !== "delegation" || delegation.devicePublicKey !== device.publicKey || delegation.audience !== audience
    || !/^[a-f0-9]{64}$/.test(delegation.principalId) || !/^[a-f0-9]{64}$/.test(delegation.networkId)
    || typeof delegation.signature !== "string" || !Number.isSafeInteger(delegation.issuedAt) || !Number.isSafeInteger(delegation.expiresAt)
    || delegation.issuedAt > now + ACCESS_CLOCK_SKEW_MS || delegation.expiresAt <= now || delegation.expiresAt - delegation.issuedAt > ACCESS_DELEGATION_TTL_MS) throw new GatewayError(403, "invalid_or_expired_device_delegation");
  validateAccessScope(delegation.scope);
  let principal: GatewayCredentials["principal"];
  if (user.principalFile) {
    const file = privateJson(user.principalFile);
    exactFields(file, ["protocol", "kind", "principal", "identity"]);
    const descriptor = record(file.principal);
    exactFields(descriptor, ["id", "publicKey", "kind", "label"]);
    // Refuse root custody before constructing any signing-key object.
    if (descriptor.id === delegation.networkId || forbiddenRootIds?.has(String(descriptor.id))) throw new GatewayError(500, "root_signing_key_forbidden");
    const key = identity(file.identity);
    if (file.protocol !== ACCESS_PROTOCOL || file.kind !== "private-identity" || descriptor.publicKey !== key.publicKey || descriptor.id !== delegation.principalId
      || accessKeyId(key.publicKey) !== delegation.principalId || !["person", "service"].includes(String(descriptor.kind)) || typeof descriptor.label !== "string") throw new GatewayError(500, "principal_identity_mismatch");
    if (descriptor.id === delegation.networkId || forbiddenRootIds?.has(String(descriptor.id))) throw new GatewayError(500, "root_signing_key_forbidden");
    principal = { identity: key, principal: descriptor as AccessPrincipal };
  }
  return { device, delegation, ...(principal ? { principal } : {}) };
}
export function loadGatewayConfig(path: string): GatewayConfig {
  const input = privateJson(path), base = dirname(resolve(path));
  exactFields(input, ["privateDirectory", "isolation", "origin", "listenHost", "brokerUrl", "audience", "tlsPin", "tls", "users", "sessionTtlSeconds", "idleTtlSeconds"]);
  if (typeof input.privateDirectory !== "string") throw new GatewayError(500, "private_directory_required");
  const privateDirectory = resolve(base, input.privateDirectory);
  let directory;
  try { directory = lstatSync(privateDirectory); } catch { throw new GatewayError(500, "private_directory_required"); }
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0 || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700 || realpathSync(privateDirectory) !== privateDirectory) throw new GatewayError(500, "gateway_requires_owned_0700_directory_and_nonroot_uid");
  const isolation = record(input.isolation); exactFields(isolation, ["gatewayUid", "brokerUid", "agentUids"]);
  if (isolation.gatewayUid !== uid || !Number.isSafeInteger(isolation.brokerUid) || Number(isolation.brokerUid) < 0 || isolation.brokerUid === uid || !Array.isArray(isolation.agentUids)
    || isolation.agentUids.some((id) => !Number.isSafeInteger(id) || Number(id) < 0 || id === uid)) throw new GatewayError(500, "gateway_uid_must_differ_from_broker_and_all_agents");
  function privatePath(value: string): string {
    const absolute = resolve(base, value);
    if (!absolute.startsWith(privateDirectory + sep) || !realpathSync(absolute).startsWith(privateDirectory + sep)) throw new GatewayError(500, "credential_outside_private_directory");
    return absolute;
  }
  privatePath(path);
  function origin(value: unknown): URL {
    try {
      if (typeof value !== "string") throw new Error();
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
      if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) throw new Error();
      return url;
    } catch { throw new GatewayError(500, "https_required_except_loopback"); }
  }
  const publicOrigin = origin(input.origin), broker = origin(input.brokerUrl);
  if (typeof input.audience !== "string" || !/^[a-f0-9]{64}$/.test(input.audience)) throw new GatewayError(500, "invalid_broker_audience");
  if (broker.protocol === "https:" && (typeof input.tlsPin !== "string" || !/^[a-f0-9]{64}$/.test(input.tlsPin))) throw new GatewayError(500, "broker_tls_pin_required");
  if (publicOrigin.protocol !== "https:" || isLoopbackHost(publicOrigin.hostname) || isIP(publicOrigin.hostname.replace(/^\[|\]$/g, ""))
    || publicOrigin.hostname.endsWith(".localhost") || publicOrigin.hostname === "scout.local" || publicOrigin.hostname.endsWith(".scout.local") || !publicOrigin.hostname.includes(".")) throw new GatewayError(500, "dedicated_https_cookie_hostname_required");
  const listenHost = typeof input.listenHost === "string" ? input.listenHost : "127.0.0.1";
  let tls: GatewayConfig["tls"];
  if (publicOrigin.protocol === "https:") {
    const files = record(input.tls); exactFields(files, ["certFile", "keyFile"]);
    if (typeof files.certFile !== "string" || typeof files.keyFile !== "string") throw new GatewayError(500, "https_certificate_and_key_required");
    tls = { cert: privateText(privatePath(files.certFile)), key: privateText(privatePath(files.keyFile)) };
  } else if (input.tls !== undefined) throw new GatewayError(500, "tls_requires_https_origin");
  const ttl = input.sessionTtlSeconds ?? 3600;
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) throw new GatewayError(500, "session_lifetime_must_be_60_to_3600_seconds");
  const idleTtl = input.idleTtlSeconds ?? 900;
  if (typeof idleTtl !== "number" || !Number.isSafeInteger(idleTtl) || idleTtl < 60 || idleTtl > 900 || idleTtl > ttl) throw new GatewayError(500, "invalid_idle_timeout");
  if (!Array.isArray(input.users) || !input.users.length || input.users.length > 100) throw new GatewayError(500, "expected_1_to_100_users");
  const seen = new Set<string>();
  const users = input.users.map((value): GatewayUserConfig => {
    const user = record(value); exactFields(user, ["login", "passwordHash", "deviceFile", "delegationFile", "principalFile"]);
    if (typeof user.login !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(user.login) || seen.has(user.login)
      || typeof user.passwordHash !== "string" || !/^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(user.passwordHash)
      || typeof user.deviceFile !== "string" || typeof user.delegationFile !== "string" || (user.principalFile !== undefined && typeof user.principalFile !== "string")) throw new GatewayError(500, "invalid_gateway_user");
    seen.add(user.login);
    return { login: user.login, passwordHash: user.passwordHash, deviceFile: privatePath(user.deviceFile), delegationFile: privatePath(user.delegationFile), ...(user.principalFile ? { principalFile: privatePath(user.principalFile as string) } : {}) };
  });
  // Read public network bindings before constructing any principal signing key.
  const roots = new Set(users.map((user) => String(privateJson(user.delegationFile).networkId)));
  const mapped = users.map((user) => loadGatewayCredentials(user, input.audience as string, Date.now(), roots));
  const devices = new Set<string>(), principals = new Set<string>();
  for (const value of mapped) {
    const deviceId = accessKeyId(value.device.publicKey), principal = value.delegation.principalId;
    if (devices.has(deviceId) || principals.has(principal)) throw new GatewayError(500, "users_must_have_distinct_principals_and_devices");
    devices.add(deviceId); principals.add(principal);
    if (value.principal && roots.has(principal)) throw new GatewayError(500, "root_signing_key_forbidden");
  }
  if ([...devices].some((id) => principals.has(id))) throw new GatewayError(500, "device_key_must_be_separate");
  return { privateDirectory, isolation: isolation as GatewayConfig["isolation"], origin: publicOrigin.origin, listenHost, brokerUrl: broker.origin, audience: input.audience, ...(input.tlsPin ? { tlsPin: String(input.tlsPin) } : {}), ...(tls ? { tls } : {}), users, sessionTtlSeconds: ttl, idleTtlSeconds: idleTtl };
}
const derive = promisify(scrypt);
export async function hashGatewayPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) throw new GatewayError(400, "password_must_be_12_to_1024_bytes");
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt, 64) as Buffer;
  return `scrypt-v1:${salt}:${hash.toString("hex")}`;
}
export async function verifyGatewayPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || Buffer.byteLength(password) > 1024 || !/^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded)) return false;
  const [, salt, hash] = encoded.split(":");
  const derived = await derive(password, salt!, 64) as Buffer;
  return timingSafeEqual(derived, Buffer.from(hash!, "hex"));
}
/** This entrypoint never spawns children. Use this sanitizer if that changes. */
export function withoutGatewaySecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/(?:LOCAL_ADMIN|SCOPED_ACCESS|ACCESS_GATEWAY|PRIVATE_KEY|KEY_FILE|DELEGATION_FILE|PRINCIPAL_FILE)/i.test(key)));
}
