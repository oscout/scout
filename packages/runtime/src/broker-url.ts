function parseHttpBrokerUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function brokerUrlHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isWildcardBrokerHostname(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::";
}

function isLoopbackBrokerHostname(hostname: string): boolean {
  return hostname === "::1"
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || /^::ffff:7f[0-9a-f]{2}:/.test(hostname)
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * A broker URL that plausibly reaches a remote peer. Self-local URLs must not
 * be persisted as another observer's route or used for cross-node forwarding.
 */
export function isReachableRemoteBrokerUrl(rawUrl: string | undefined): rawUrl is string {
  const url = parseHttpBrokerUrl(rawUrl);
  if (!url) {
    return false;
  }
  const hostname = brokerUrlHostname(url);
  return !isWildcardBrokerHostname(hostname) && !isLoopbackBrokerHostname(hostname);
}

/**
 * A broker URL this host can dial at all. Loopback remains valid for sibling
 * brokers on one machine; wildcard listen addresses are never destinations.
 */
export function isRoutableBrokerUrl(rawUrl: string | undefined): rawUrl is string {
  const url = parseHttpBrokerUrl(rawUrl);
  return url !== null && !isWildcardBrokerHostname(brokerUrlHostname(url));
}
