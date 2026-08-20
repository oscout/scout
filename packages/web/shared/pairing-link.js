export const SCOUT_PAIRING_DEEP_LINK_SCHEME = "scout";
export const SCOUT_PAIRING_DEEP_LINK_PATH = "pair";

export function pairingDeepLink(qrValue) {
  const payload = typeof qrValue === "string" ? qrValue.trim() : "";
  return payload
    ? `${SCOUT_PAIRING_DEEP_LINK_SCHEME}://${SCOUT_PAIRING_DEEP_LINK_PATH}?payload=${encodeURIComponent(payload)}`
    : null;
}

export function pairingDeepLinks(qrValue) {
  const payload = parsePairingPayload(qrValue);
  const fallback = pairingDeepLink(qrValue);
  if (!payload) {
    return { default: fallback, lan: null, tailnet: null };
  }

  const relayUrls = deduplicatedRelayUrls(payload.relay, payload.fallbackRelays ?? []);
  const lanRelay = relayUrls.find(relayUrlUsesLAN);
  const tailnetRelay = relayUrls.find(relayUrlUsesTailnet);

  return {
    default: fallback,
    lan: lanRelay ? pairingDeepLink(JSON.stringify(payloadPromotingRelay(payload, lanRelay))) : null,
    tailnet: tailnetRelay ? pairingDeepLink(JSON.stringify(payloadPromotingRelay(payload, tailnetRelay))) : null,
  };
}

function parsePairingPayload(qrValue) {
  const payload = typeof qrValue === "string" ? qrValue.trim() : "";
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || typeof parsed.relay !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function payloadPromotingRelay(payload, relay) {
  const relayUrls = deduplicatedRelayUrls(relay, [
    payload.relay,
    ...(Array.isArray(payload.fallbackRelays) ? payload.fallbackRelays : []),
  ]);
  const next = {
    ...payload,
    relay: relayUrls[0],
  };
  if (relayUrls.length > 1) {
    next.fallbackRelays = relayUrls.slice(1);
  } else {
    delete next.fallbackRelays;
  }
  return next;
}

function deduplicatedRelayUrls(primary, fallbacks) {
  const urls = [];
  const seen = new Set();
  for (const value of [primary, ...fallbacks]) {
    if (typeof value !== "string") continue;
    const relay = value.trim();
    if (!relay || seen.has(relay)) continue;
    seen.add(relay);
    urls.push(relay);
  }
  return urls;
}

function relayUrlUsesLAN(rawValue) {
  const host = relayHost(rawValue);
  if (!host) return false;
  if (host.endsWith(".local")) return true;
  const parts = ipv4Parts(host);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 10
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254);
}

function relayUrlUsesTailnet(rawValue) {
  const host = relayHost(rawValue);
  if (!host) return false;
  if (host.endsWith(".ts.net")) return true;
  const parts = ipv4Parts(host);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

function relayHost(rawValue) {
  try {
    return new URL(rawValue).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function ipv4Parts(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  return numbers.every(Number.isFinite) ? numbers : null;
}
