#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const surfaceRoot = resolve(process.argv[2] || "../../apps/ios/Scout/Resources/WebSurfaces");
const manifestPath = resolve(surfaceRoot, "manifest.json");

function fail(message) {
  console.error(`error: Scout native web surfaces invalid: ${message}`);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail(
    `missing ${manifestPath}. Native surfaces live in the private iOS app and are not a public oscout/scout check surface; run bun run build:native-surfaces only from the private product checkout.`,
  );
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`cannot decode manifest.json (${error instanceof Error ? error.message : String(error)})`);
}

if (manifest?.schemaVersion !== 1) fail("unsupported or missing schemaVersion");
for (const [surface, expectedEntry] of [
  ["lanes", "lanes/index.html"],
  ["deck", "deck/index.html"],
  ["dispatch", "dispatch/index.html"],
  ["chat", "chat/index.html"],
]) {
  if (manifest.surfaces?.[surface]?.entry !== expectedEntry) fail(`${surface} entry must be ${expectedEntry}`);
}

const requiredChatCapabilities = [
  "bootstrap",
  "chat.snapshot",
  "chat.send",
  "chat.upload",
  "chat.attachment.fetch",
  "chat.markRead",
  "chat.interrupt",
  "chat.answer",
  "chat.decide",
  "native.close",
];
const chatCapabilities = new Set(manifest.surfaces?.chat?.capabilities);
for (const capability of requiredChatCapabilities) {
  if (!chatCapabilities.has(capability)) fail(`chat capability missing: ${capability}`);
}

const files = Array.isArray(manifest.files) ? manifest.files : fail("files must be an array");
for (const file of files) {
  if (!file || typeof file.path !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.includes("..")) {
    fail("manifest contains an invalid asset path");
  }
  const absolute = resolve(surfaceRoot, file.path);
  if (!absolute.startsWith(`${surfaceRoot}/`) || !existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`missing asset ${file.path}`);
  }
  const contents = readFileSync(absolute);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== file.sha256) fail(`hash mismatch for ${file.path}; rebuild native surfaces`);
  if (contents.byteLength !== file.bytes) fail(`size mismatch for ${file.path}; rebuild native surfaces`);
}

console.log(`Scout native web surfaces ${manifest.assetRevision} validated (${files.length} files)`);
