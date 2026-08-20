import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

export type ScoutServicesRestartTarget = "broker" | "relay" | "web" | "all";

const SERVICE_LINK_SECRET_FILE = "service-link-signing.key";
const SERVICE_LINK_VERSION = "v1";
const SERVICE_LINK_TTL_MS = 60_000;

const RESTART_TARGETS = new Set<ScoutServicesRestartTarget>([
  "broker",
  "relay",
  "web",
  "all",
]);

export function parseScoutServicesRestartTarget(
  value: string | undefined | null,
): ScoutServicesRestartTarget | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return RESTART_TARGETS.has(normalized as ScoutServicesRestartTarget)
    ? normalized as ScoutServicesRestartTarget
    : null;
}

export function createSignedScoutServicesRestartUrl(
  target: ScoutServicesRestartTarget,
  options: { nowMs?: number; nonce?: string } = {},
): { url: string; expiresAt: number } {
  const nowMs = options.nowMs ?? Date.now();
  const expiresAt = nowMs + SERVICE_LINK_TTL_MS;
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const payload = serviceLinkPayload("restart", target, String(expiresAt), nonce);
  const sig = signPayload(payload);
  const params = new URLSearchParams({
    expires: String(expiresAt),
    nonce,
    sig,
  });

  return {
    url: `scout://services/restart/${target}?${params.toString()}`,
    expiresAt,
  };
}

export function verifySignedScoutServicesRestartUrl(
  url: string,
  options: { nowMs?: number } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "scout:" || parsed.hostname !== "services") {
    return false;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const action = parts[0];
  const target = parseScoutServicesRestartTarget(parts[1]);
  if (action !== "restart" || !target) {
    return false;
  }

  const expires = parsed.searchParams.get("expires") ?? "";
  const nonce = parsed.searchParams.get("nonce") ?? "";
  const sig = parsed.searchParams.get("sig") ?? "";
  if (!expires || !nonce || !sig) {
    return false;
  }

  const expiresMs = Number(expires);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(expiresMs) || expiresMs < nowMs || expiresMs > nowMs + SERVICE_LINK_TTL_MS * 2) {
    return false;
  }

  const expected = signPayload(serviceLinkPayload(action, target, expires, nonce));
  return timingSafeStringEqual(expected, sig);
}

function serviceLinkPayload(
  action: string,
  target: ScoutServicesRestartTarget,
  expires: string,
  nonce: string,
): string {
  return [
    SERVICE_LINK_VERSION,
    "services",
    action,
    target,
    expires,
    nonce,
  ].join("\n");
}

function signPayload(payload: string): string {
  return createHmac("sha256", readOrCreateServiceLinkSecret())
    .update(payload)
    .digest("base64url");
}

function serviceLinkSecretPath(): string {
  return join(resolveOpenScoutSupportPaths().supportDirectory, SERVICE_LINK_SECRET_FILE);
}

function readOrCreateServiceLinkSecret(): Buffer {
  const path = serviceLinkSecretPath();
  if (existsSync(path)) {
    return Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
  }

  const supportDirectory = resolveOpenScoutSupportPaths().supportDirectory;
  mkdirSync(supportDirectory, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  try {
    writeFileSync(path, `${secret.toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(path, 0o600);
    return secret;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      return Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    }
    throw err;
  }
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
