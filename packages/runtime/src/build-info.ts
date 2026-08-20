import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScoutBrokerBuildIdentity } from "./broker-api.js";

let cachedBuildIdentity: ScoutBrokerBuildIdentity | null = null;

function envString(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function readRuntimePackageJson(): { name: string | null; version: string | null } {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      version: typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

export function loadOpenScoutRuntimeBuildIdentity(): ScoutBrokerBuildIdentity {
  if (cachedBuildIdentity) {
    return cachedBuildIdentity;
  }

  const packageJson = readRuntimePackageJson();
  cachedBuildIdentity = {
    packageName: packageJson.name ?? "@openscout/runtime",
    version: envString("SCOUT_APP_VERSION", "OPENSCOUT_VERSION", "npm_package_version") ?? packageJson.version,
    commit: envString(
      "OPENSCOUT_BUILD_COMMIT",
      "OPENSCOUT_BUILD_SHA",
      "GIT_COMMIT",
      "GIT_SHA",
      "SOURCE_VERSION",
      "VERCEL_GIT_COMMIT_SHA",
    ),
    branch: envString("OPENSCOUT_BUILD_BRANCH", "GIT_BRANCH", "VERCEL_GIT_COMMIT_REF"),
    buildId: envString("OPENSCOUT_BUILD_ID", "SCOUT_BUILD_ID"),
    buildNumber: envString("OPENSCOUT_BUILD_NUMBER", "BUILD_NUMBER"),
    mode: process.env.NODE_ENV === "production" ? "production" : "dev",
  };
  return cachedBuildIdentity;
}
