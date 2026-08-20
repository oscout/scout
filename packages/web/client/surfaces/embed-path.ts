const LEGACY_EMBED_PREFIXES = [
  "/embed/",
  "/ops/lanes/embed",
] as const;

/** Fast path check before loading the discovery registry chunk. */
export function isLikelyDiscoveredEmbedPath(pathname: string): boolean {
  if (pathname === "/ops/lanes/embed") return true;
  return pathname.startsWith("/embed/");
}

export function isLegacyStandaloneEmbedPath(pathname: string): boolean {
  if (pathname === "/embed/repo-diff") return true;
  if (pathname === "/embed/session") return true;
  if (pathname === "/embed/terminal") return true;
  if (/^\/embed\/observe\/[^/]+$/.test(pathname)) return true;
  return false;
}

export function shouldBootstrapDiscoveredEmbed(pathname: string): boolean {
  if (!isLikelyDiscoveredEmbedPath(pathname)) return false;
  return !isLegacyStandaloneEmbedPath(pathname);
}