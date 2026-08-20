#!/usr/bin/env node
/**
 * Sign a freshly built OpenScout DMG and prepend it to the Sparkle appcast.
 *
 * Usage:
 *   node scripts/update-appcast.mjs <version> <dmg-path> [--skip-if-placeholder]
 *
 * The enclosure URL reuses the immutable GitHub release-asset convention from
 * scripts/ship-release.mjs:
 *   https://github.com/<org>/<repo>/releases/download/v<version>/OpenScout-<version>.dmg
 *
 * HARD GUARD: refuses to sign anything while ScoutInfo.plist still carries the
 * SUPublicEDKey placeholder or when the configured signer does not match the
 * public key embedded in the app. A signed appcast against the wrong key is
 * worse than no appcast.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const PLIST_PATH = path.join(repoRoot, "apps/macos/ScoutInfo.plist");
const APPCAST_PATH = path.join(repoRoot, "apps/macos/appcast.xml");
const ARTIFACTS_DIR = path.join(repoRoot, "apps/macos/.build/artifacts");
const ED_KEY_PLACEHOLDER = "REPLACE-WITH-GENERATED-ED-KEY";
const RELEASE_DOWNLOAD_BASE = "https://github.com/oscout/scout/releases/download";
const MAX_ITEMS = 5;
const SPARKLE_ACCOUNT = process.env.OPENSCOUT_SPARKLE_ACCOUNT?.trim() || "openscout";
const SPARKLE_PRIVATE_KEY = process.env.OPENSCOUT_SPARKLE_PRIVATE_KEY?.trim() || null;
const SPARKLE_PUBLIC_KEY = process.env.OPENSCOUT_SPARKLE_PUBLIC_KEY?.trim() || null;

function usage() {
  return `Usage:
  node scripts/update-appcast.mjs <version> <dmg-path> [--skip-if-placeholder]`;
}

function parseArgs(argv) {
  const options = { skipIfPlaceholder: false };
  const positionals = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--skip-if-placeholder") {
      options.skipIfPlaceholder = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }
  const [version, dmgPath] = positionals;
  if (!version || !dmgPath) {
    throw new Error(`Missing arguments.\n${usage()}`);
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Version must look like X.Y.Z, got: ${version}`);
  }
  return { version, dmgPath, ...options };
}

/** The maintainer pastes the real key into ScoutInfo.plist once (see runbook). */
function publicEdKey() {
  const plist = readFileSync(PLIST_PATH, "utf8");
  const match = plist.match(/<key>SUPublicEDKey<\/key>\s*<string>([^<]*)<\/string>/);
  return match ? match[1].trim() : null;
}

/** Recursively locate a modern Sparkle tool, skipping the legacy DSA scripts. */
function findSparkleTool(dir, toolName) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "old_dsa_scripts") continue;
      const found = findSparkleTool(full, toolName);
      if (found) return found;
    } else if (entry.name === toolName) {
      return full;
    }
  }
  return null;
}

function signDmg(signUpdate, dmgAbsPath) {
  const args = SPARKLE_PRIVATE_KEY
    ? ["--ed-key-file", "-", dmgAbsPath]
    : ["--account", SPARKLE_ACCOUNT, dmgAbsPath];
  const output = execFileSync(signUpdate, args, {
    encoding: "utf8",
    input: SPARKLE_PRIVATE_KEY ? `${SPARKLE_PRIVATE_KEY}\n` : undefined,
  });
  const edSignature = output.match(/sparkle:edSignature="([^"]+)"/)?.[1];
  const length = output.match(/length="([^"]+)"/)?.[1];
  if (!edSignature || !length) {
    throw new Error(`Could not parse sign_update output:\n${output}`);
  }
  return { edSignature, length };
}

function normalizedPublicEdKey(value, source) {
  const key = value?.trim();
  if (!key || key === ED_KEY_PLACEHOLDER) {
    throw new Error(`${source} does not contain a configured Sparkle Ed25519 public key.`);
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== key) {
    throw new Error(`${source} is not a canonical base64-encoded Ed25519 public key.`);
  }
  return key;
}

function signerPublicEdKey(generateKeys) {
  if (SPARKLE_PUBLIC_KEY) {
    return normalizedPublicEdKey(SPARKLE_PUBLIC_KEY, "OPENSCOUT_SPARKLE_PUBLIC_KEY");
  }
  if (SPARKLE_PRIVATE_KEY) {
    throw new Error(
      "OPENSCOUT_SPARKLE_PUBLIC_KEY is required when signing with " +
        "OPENSCOUT_SPARKLE_PRIVATE_KEY.",
    );
  }
  if (!generateKeys) {
    throw new Error(
      `Could not find Sparkle's generate_keys under ${path.relative(repoRoot, ARTIFACTS_DIR)}. ` +
        "Resolve the Sparkle SPM dependency first (build the macOS app).",
    );
  }
  const output = execFileSync(generateKeys, ["--account", SPARKLE_ACCOUNT, "-p"], {
    encoding: "utf8",
  });
  return normalizedPublicEdKey(output, `Sparkle Keychain account ${SPARKLE_ACCOUNT}`);
}

function existingPubDate(version) {
  const appcast = readFileSync(APPCAST_PATH, "utf8");
  const versionElement = `<sparkle:version>${version}</sparkle:version>`;
  const item = [...appcast.matchAll(/[ \t]*<item>[\s\S]*?<\/item>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(versionElement));
  return item?.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ?? null;
}

function buildItem({ version, edSignature, length, pubDate }) {
  const url = `${RELEASE_DOWNLOAD_BASE}/v${version}/OpenScout-${version}.dmg`;
  return [
    "    <item>",
    `      <title>OpenScout ${version}</title>`,
    `      <pubDate>${pubDate}</pubDate>`,
    `      <sparkle:version>${version}</sparkle:version>`,
    `      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>`,
    `      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>`,
    `      <enclosure url="${url}" sparkle:version="${version}" sparkle:shortVersionString="${version}" sparkle:edSignature="${edSignature}" length="${length}" type="application/octet-stream" />`,
    "    </item>",
  ].join("\n");
}

function writeAppcast(newItem, version) {
  const appcast = readFileSync(APPCAST_PATH, "utf8");
  const versionElement = `<sparkle:version>${version}</sparkle:version>`;
  const existing = [...appcast.matchAll(/[ \t]*<item>[\s\S]*?<\/item>/g)]
    .map((m) => m[0].replace(/^\s*\n/, ""))
    .filter((item) => !item.includes(versionElement));
  const shell = appcast.replace(/\s*<item>[\s\S]*?<\/item>/g, "");
  const kept = [newItem, ...existing].slice(0, MAX_ITEMS).join("\n");
  const result = shell.replace(/(\n)?[ \t]*<\/channel>/, `\n${kept}\n  </channel>`);
  writeFileSync(APPCAST_PATH, result);
}

function main() {
  const { version, dmgPath, skipIfPlaceholder } = parseArgs(process.argv.slice(2));

  let edKey;
  try {
    edKey = normalizedPublicEdKey(publicEdKey(), "apps/macos/ScoutInfo.plist");
  } catch (error) {
    const message =
      `${error instanceof Error ? error.message : String(error)} ` +
      "Run Sparkle's generate_keys --account openscout once and embed the public key before signing an appcast.";
    if (skipIfPlaceholder) {
      console.warn(`Skipping appcast update: ${message}`);
      return;
    }
    throw new Error(message);
  }

  const dmgAbsPath = path.resolve(repoRoot, dmgPath);
  if (!existsSync(dmgAbsPath)) {
    throw new Error(`DMG not found: ${dmgPath}`);
  }

  const signUpdate = findSparkleTool(ARTIFACTS_DIR, "sign_update");
  if (!signUpdate) {
    throw new Error(
      `Could not find Sparkle's sign_update under ${path.relative(repoRoot, ARTIFACTS_DIR)}. ` +
        "Resolve the Sparkle SPM dependency first (build the macOS app).",
    );
  }

  const generateKeys = findSparkleTool(ARTIFACTS_DIR, "generate_keys");
  const signerKey = signerPublicEdKey(generateKeys);
  if (signerKey !== edKey) {
    throw new Error(
      "The configured Sparkle signer does not match SUPublicEDKey in apps/macos/ScoutInfo.plist.",
    );
  }

  const { edSignature, length } = signDmg(signUpdate, dmgAbsPath);
  const pubDate = existingPubDate(version) ?? new Date().toUTCString();
  writeAppcast(buildItem({ version, edSignature, length, pubDate }), version);
  console.log(`Wrote OpenScout ${version} to apps/macos/appcast.xml (length ${length}).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
