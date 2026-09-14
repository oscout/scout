#!/usr/bin/env node
// Generate Scoutbot TTS fixtures for the FX lab.
//
// Calls Scout's owned `/api/voice/speak` route for each phrase and writes the
// returned audio to packages/web/dev/scoutbot-fx-fixtures/. Scout Menu must be
// running because it owns the embedded synthesis engine.
//
// Usage:
//   node packages/web/scripts/generate-scoutbot-fx-fixtures.mjs
//   node packages/web/scripts/generate-scoutbot-fx-fixtures.mjs --voice af_bella
//
// Env:
//   OPENSCOUT_WEB_URL, OPENSCOUT_WEB_BUN_URL, OPENSCOUT_WEB_PORT,
//   OPENSCOUT_VOICE_TTS_MODEL_ID, OPENSCOUT_VOICE_TTS_VOICE_ID

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RPC_TIMEOUT_MS = 30_000;
const DEFAULT_SCOUT_WEB_URL = "http://127.0.0.1:43120";

const PHRASES = [
  { slug: "copy-nominal", text: "Scoutbot, copy. Three lattices reporting nominal. Standing by." },
  { slug: "agent-online", text: "Heads up — pixel-pirate just came back online. Inbox clear." },
  { slug: "broker-status", text: "Broker is steady. No pending asks. Two work items in flight." },
  { slug: "checkback", text: "Check back in two minutes on the migration. I'll holler if anything moves." },
  { slug: "incoming", text: "Incoming from lattice-seven: needs a routing decision on the new mission." },
  { slug: "all-quiet", text: "All quiet on the mesh. No alerts. Standing by for your next move." },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "..", "dev", "scoutbot-fx-fixtures");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--voice") out.voice = argv[++i];
    else if (arg === "--model") out.model = argv[++i];
    else if (arg === "--speed") out.speed = Number(argv[++i]);
  }
  return out;
}

function readPreferredVoice() {
  return process.env.OPENSCOUT_VOICE_TTS_VOICE_ID?.trim() || undefined;
}

function readPreferredModel() {
  return process.env.OPENSCOUT_VOICE_TTS_MODEL_ID?.trim() || undefined;
}

function scoutWebURL() {
  const configured = process.env.OPENSCOUT_WEB_URL
    ?? process.env.OPENSCOUT_WEB_BUN_URL
    ?? (process.env.OPENSCOUT_WEB_PORT
      ? `http://127.0.0.1:${process.env.OPENSCOUT_WEB_PORT}`
      : DEFAULT_SCOUT_WEB_URL);
  return configured.replace(/\/$/, "");
}

async function synthesize({ text, modelId, voiceId, speed, webURL }) {
  const response = await fetch(`${webURL}/api/voice/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, modelId, voiceId, speed }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Scout voice returned HTTP ${response.status}`);
  }
  return body;
}

function extensionForContentType(contentType) {
  if (contentType === "audio/mpeg") return "mp3";
  if (contentType === "audio/x-caf") return "caf";
  return "wav";
}

async function main() {
  const args = parseArgs(process.argv);
  const webURL = scoutWebURL();
  const modelId = args.model ?? readPreferredModel();
  const voiceId = args.voice ?? readPreferredVoice();
  const speed = args.speed;

  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });

  console.log(`[scoutbot-fx] Scout Menu via ${webURL} model=${modelId ?? "(menu default)"} voice=${voiceId ?? "(menu default)"}`);
  console.log(`[scoutbot-fx] Writing to ${FIXTURE_DIR}`);

  const manifest = [];
  for (const phrase of PHRASES) {
    process.stdout.write(`  ↪ ${phrase.slug} ... `);
    try {
      const result = await synthesize({ text: phrase.text, modelId, voiceId, speed, webURL });
      const audioBase64 = typeof result.audioBase64 === "string" ? result.audioBase64 : "";
      if (!audioBase64) throw new Error("Scout Menu returned no audio");
      const audioBytes = Buffer.from(audioBase64, "base64");
      const extension = extensionForContentType(result.contentType);
      const file = `${phrase.slug}.${extension}`;
      const outPath = join(FIXTURE_DIR, file);
      writeFileSync(outPath, audioBytes);
      manifest.push({
        slug: phrase.slug,
        text: phrase.text,
        file,
        contentType: result.contentType ?? "audio/wav",
        modelId: result.modelId ?? modelId,
        voiceId: result.voiceId ?? voiceId ?? "",
        bytes: audioBytes.length,
      });
      process.stdout.write(`${audioBytes.length} bytes\n`);
    } catch (error) {
      process.stdout.write(`FAILED — ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    }
  }

  const manifestPath = join(FIXTURE_DIR, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), fixtures: manifest }, null, 2)}\n`);
  console.log(`[scoutbot-fx] Wrote manifest.json (${manifest.length} fixtures)`);
}

main().catch((error) => {
  console.error(`[scoutbot-fx] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
