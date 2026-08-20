#!/usr/bin/env node
// Generate Scoutbot TTS fixtures for the FX lab.
//
// Reads Vox runtime port from ~/.vox/runtime.json (or VOX_PORT), calls Vox's
// `synthesize.generate` over WS for each phrase below, and writes WAV files to
// packages/web/dev/scoutbot-fx-fixtures/. The dir is gitignored. Re-run to refresh.
//
// Usage:
//   node packages/web/scripts/generate-scoutbot-fx-fixtures.mjs
//   node packages/web/scripts/generate-scoutbot-fx-fixtures.mjs --voice af_bella
//
// Env:
//   VOX_HOME, VOX_PORT, OPENSCOUT_VOX_TTS_MODEL_ID, OPENSCOUT_VOX_TTS_VOICE_ID

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const VOX_CLIENT_ID = "openscout-scoutbot-fx-fixtures";
const DEFAULT_VOX_RPC_PORT = 42137;
const DEFAULT_VOX_RPC_HOST = "127.0.0.1";
const RPC_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "avspeech:system";

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

function voxHome() {
  return process.env.VOX_HOME ?? join(homedir(), ".vox");
}

function resolveRpcPort() {
  if (process.env.VOX_PORT) {
    const port = Number(process.env.VOX_PORT);
    if (Number.isFinite(port) && port > 0) return port;
  }
  const runtimePath = join(voxHome(), "runtime.json");
  if (existsSync(runtimePath)) {
    try {
      const parsed = JSON.parse(readFileSync(runtimePath, "utf8"));
      const port = Number(parsed.port);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      // fall through
    }
  }
  return DEFAULT_VOX_RPC_PORT;
}

function readPreferredVoice() {
  const fromEnv = process.env.OPENSCOUT_VOX_TTS_VOICE_ID ?? process.env.VOX_TTS_VOICE_ID;
  if (fromEnv?.trim()) return fromEnv.trim();
  const prefsPath = join(voxHome(), "preferences.json");
  if (!existsSync(prefsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(prefsPath, "utf8"));
    const voice = parsed?.speech?.preferredSynthesisVoiceId;
    return typeof voice === "string" && voice.trim() ? voice.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readPreferredModel() {
  const fromEnv = process.env.OPENSCOUT_VOX_TTS_MODEL_ID ?? process.env.VOX_TTS_MODEL_ID;
  if (fromEnv?.trim()) return fromEnv.trim();
  const prefsPath = join(voxHome(), "preferences.json");
  if (!existsSync(prefsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(prefsPath, "utf8"));
    const model = parsed?.speech?.preferredSynthesisModelId;
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function synthesize({ text, modelId, voiceId, speed, port }) {
  return await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://${DEFAULT_VOX_RPC_HOST}:${port}`);
    const id = randomUUID();
    const cleanup = () => {
      clearTimeout(timeout);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Vox synthesize.generate timed out after ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);
    socket.onopen = () => {
      socket.send(JSON.stringify({
        id,
        method: "synthesize.generate",
        params: {
          clientId: VOX_CLIENT_ID,
          text,
          modelId,
          voiceId,
          format: "wav",
          speed,
        },
      }));
    };
    socket.onmessage = (event) => {
      const raw = typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : "";
      if (!raw) return;
      let payload;
      try { payload = JSON.parse(raw); } catch { return; }
      if (payload.id !== id) return;
      cleanup();
      if (payload.error) {
        reject(new Error(typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error)));
        return;
      }
      resolvePromise(payload.result ?? {});
    };
    socket.onerror = () => {
      cleanup();
      reject(new Error(`Could not connect to Vox on port ${port}`));
    };
    socket.onclose = () => {
      cleanup();
      reject(new Error("Vox closed the connection before returning a result"));
    };
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const port = resolveRpcPort();
  const modelId = args.model ?? readPreferredModel() ?? DEFAULT_MODEL;
  const voiceId = args.voice ?? readPreferredVoice();
  const speed = args.speed;

  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });

  console.log(`[scoutbot-fx] Vox port=${port} model=${modelId} voice=${voiceId ?? "(default)"}`);
  console.log(`[scoutbot-fx] Writing to ${FIXTURE_DIR}`);

  const manifest = [];
  for (const phrase of PHRASES) {
    process.stdout.write(`  ↪ ${phrase.slug} ... `);
    try {
      const result = await synthesize({ text: phrase.text, modelId, voiceId, speed, port });
      const audioBase64 = typeof result.audioBase64 === "string" ? result.audioBase64 : "";
      if (!audioBase64) throw new Error("Vox returned no audio");
      const audioBytes = Buffer.from(audioBase64, "base64");
      const outPath = join(FIXTURE_DIR, `${phrase.slug}.wav`);
      writeFileSync(outPath, audioBytes);
      manifest.push({
        slug: phrase.slug,
        text: phrase.text,
        file: `${phrase.slug}.wav`,
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
