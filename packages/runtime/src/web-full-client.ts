// Where `scout web install` puts the full web client, and how the web server
// finds it. The npm package bundles the basic client (Home, DMs, Tail) beside
// its server; when the full client for the same version is installed under
// the support directory, packaged servers serve that instead.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export const WEB_FULL_PROFILE_FILE = "scout-web-profile.json";

export interface WebFullClientProfile {
  profile: "full";
  version: string;
  builtAt?: string;
}

export function webFullClientsDirectory(supportDirectory = resolveOpenScoutSupportPaths().supportDirectory): string {
  return join(supportDirectory, "web", "full");
}

export function webFullClientDirectory(version: string, supportDirectory?: string): string {
  return join(webFullClientsDirectory(supportDirectory), version);
}

export function readWebFullClientProfile(directory: string): WebFullClientProfile | null {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, WEB_FULL_PROFILE_FILE), "utf8")) as Partial<WebFullClientProfile>;
    if (parsed.profile !== "full" || typeof parsed.version !== "string") return null;
    return { profile: "full", version: parsed.version, builtAt: parsed.builtAt };
  } catch {
    return null;
  }
}

/**
 * Which client a static root holds. The basic build and full installs both
 * write the profile file; a root without one (source builds, dev) is full.
 */
export function readWebClientProfile(directory: string): "basic" | "full" {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, WEB_FULL_PROFILE_FILE), "utf8")) as { profile?: unknown };
    return parsed.profile === "basic" ? "basic" : "full";
  } catch {
    return "full";
  }
}

/**
 * The installed full client for exactly this version, or null. A client built
 * for another version may call routes this server doesn't have, so it is never
 * used as a fallback. `OPENSCOUT_WEB_CLIENT_PROFILE=basic` opts out.
 */
export function resolveInstalledWebFullClient(
  version: string | null | undefined,
  options: { env?: NodeJS.ProcessEnv; supportDirectory?: string } = {},
): string | null {
  const env = options.env ?? process.env;
  if (env.OPENSCOUT_WEB_CLIENT_PROFILE?.trim() === "basic") return null;
  if (!version) return null;
  const directory = webFullClientDirectory(version, options.supportDirectory);
  if (!existsSync(join(directory, "index.html"))) return null;
  return readWebFullClientProfile(directory)?.version === version ? directory : null;
}

/**
 * The version of a packaged Scout build, read beside its bundled entry:
 * dist/build-manifest.json first, then the package.json one level up.
 */
export function readBundledScoutVersion(distDirectory: string): string | null {
  for (const candidate of [join(distDirectory, "build-manifest.json"), join(distDirectory, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
