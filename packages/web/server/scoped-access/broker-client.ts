import { verifySignedNodeCard, type SignedNodeCard } from "@openscout/runtime/mesh/node-identity";
import { ACCESS_CLOCK_SKEW_MS, ACCESS_PROTOCOL, ACCESS_ARTIFACT_MAX_BYTES } from "@openscout/runtime/mesh/access";
import { signScopedPeerRequest } from "@openscout/runtime/mesh/peer-auth";
import { createPinnedHttpsClient, type PinnedHttpsClient } from "@openscout/runtime/mesh/pinned-https-client";
import { GatewayError, loadGatewayCredentials, record, isLoopbackHost, type GatewayConfig, type GatewayUserConfig } from "./config.ts";

export type GatewayBroker = { call(user: GatewayUserConfig, operation: Record<string, unknown>): Promise<unknown>; submit(artifact: unknown): Promise<unknown>; close(): void };
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new GatewayError(502, "invalid_broker_response");
  const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 1024 * 1024) throw new GatewayError(502, "broker_response_too_large"); chunks.push(chunk.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof GatewayError) throw error; throw new GatewayError(502, "invalid_broker_response"); }
  finally { await reader.cancel().catch(() => {}); }
}
export function createGatewayBroker(config: GatewayConfig, deps: { fetch?: typeof fetch; pinned?: PinnedHttpsClient; now?: () => number } = {}): GatewayBroker {
  const base = new URL(config.brokerUrl);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash || !["http:", "https:"].includes(base.protocol)
    || (base.protocol === "http:" && !isLoopbackHost(base.hostname))) throw new GatewayError(500, "https_required_except_loopback");
  if (base.protocol === "https:" && !/^[a-f0-9]{64}$/.test(config.tlsPin ?? "")) throw new GatewayError(500, "broker_tls_pin_required");
  const pinned = deps.pinned ?? createPinnedHttpsClient();
  const now = deps.now ?? Date.now;
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const url = new URL(path, config.brokerUrl).toString();
    const options = { ...init, redirect: "error" as const, signal: AbortSignal.timeout(15_000) };
    try {
      return config.brokerUrl.startsWith("https:")
        ? await pinned.fetch(url, { spkiFingerprint: config.tlsPin!, expectedKeyId: config.audience }, options)
        : await (deps.fetch ?? fetch)(url, options);
    } catch { throw new GatewayError(502, "broker_connection_failed"); }
  };
  async function requireCard() {
      const response = await request("/v1/node", { method: "GET", headers: { accept: "application/json" } });
      if (!response.ok) throw new GatewayError(502, "broker_capability_unavailable");
      try {
        const card = record(record(await boundedJson(response)).card) as SignedNodeCard;
        if (!verifySignedNodeCard(card, now()) || card.keyId !== config.audience || !Array.isArray(card.capabilities) || !card.capabilities.includes(ACCESS_PROTOCOL)
          || !Number.isSafeInteger(card.issuedAt) || card.issuedAt > now() + ACCESS_CLOCK_SKEW_MS
          || (config.brokerUrl.startsWith("https:") && card.tls?.spkiFingerprint !== config.tlsPin)) throw new Error();
      } catch { throw new GatewayError(502, "broker_identity_or_capability_mismatch"); }
  }
  return {
    async call(user, operation) {
      // Reload on every operation. Expiry, rotation and receiver revocation never
      // inherit authority from the browser's session lifetime.
      const credentials = loadGatewayCredentials(user, config.audience, now());
      await requireCard();
      const body = JSON.stringify({ ...operation, delegation: credentials.delegation });
      const headers = signScopedPeerRequest(credentials.device, { delegation: credentials.delegation, method: "POST", path: "/v1/access/rpc", body, destinationKeyId: config.audience });
      const result = await request("/v1/access/rpc", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
      const payload = await boundedJson(result);
      if (!result.ok) throw new GatewayError(result.status >= 400 && result.status < 500 ? result.status : 502, "broker_operation_denied");
      return payload;
    },
    async submit(artifact) {
      const body = JSON.stringify({ artifact });
      if (Buffer.byteLength(body) > ACCESS_ARTIFACT_MAX_BYTES) throw new GatewayError(413, "artifact_too_large");
      await requireCard();
      const result = await request("/v1/access/policy", { method: "POST", headers: { "content-type": "application/json" }, body });
      const payload = await boundedJson(result);
      if (!result.ok) throw new GatewayError(result.status >= 400 && result.status < 500 ? result.status : 502, "broker_policy_denied");
      return payload;
    },
    close: () => pinned.close(),
  };
}
