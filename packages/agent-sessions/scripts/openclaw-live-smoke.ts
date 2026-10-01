import { randomUUID } from "node:crypto";
import { createLocalAgentClient } from "../src/local/index.js";

// Explicit opt-in script: calls a real Gateway and consumes provider tokens.
// Command/args overrides also allow SSH stdio transport without local OpenClaw.
const command = process.env.OPENCLAW_SMOKE_COMMAND;
const args: unknown = process.env.OPENCLAW_SMOKE_ARGS
  ? JSON.parse(process.env.OPENCLAW_SMOKE_ARGS) : undefined;
if (args !== undefined && (!Array.isArray(args) || !args.every(arg => typeof arg === "string"))) {
  throw new Error("OPENCLAW_SMOKE_ARGS must be a JSON array of strings.");
}
const options = {
  harness: "openclaw" as const,
  cwd: process.env.OPENCLAW_SMOKE_CWD || process.cwd(),
  timeoutMs: 120_000,
  adapterOptions: {
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    startupTimeoutMs: 60_000,
  },
};
const marker = `SCOUT_${randomUUID().replaceAll("-", "")}`;
let nativeId: string | undefined;
const first = await createLocalAgentClient(options);
try {
  const fresh = await first.turn(`This is a connectivity test. Remember the marker ${marker}. Reply with only that marker. Do not use tools.`);
  if (!fresh.text.includes(marker) || !fresh.session.nativeId) {
    throw new Error("Fresh turn did not return the marker and native session id.");
  }
  nativeId = fresh.session.nativeId;
  console.log(JSON.stringify({ stage: "fresh", passed: true, sessionId: nativeId }));
  const warm = await first.turn("What marker did I ask you to remember? Reply with only the marker. Do not use tools.");
  if (!warm.text.includes(marker) || warm.session.nativeId !== nativeId || !warm.session.reused) {
    throw new Error("Warm continuation lost session identity or context.");
  }
  console.log(JSON.stringify({ stage: "warm", passed: true, sessionId: nativeId }));
} finally {
  await first.close();
}
const resumed = await createLocalAgentClient({ ...options, reuseKey: nativeId });
try {
  const cold = await resumed.turn("What marker did I ask you to remember earlier? Reply with only the marker. Do not use tools.");
  if (!cold.text.includes(marker) || cold.session.nativeId !== nativeId) {
    throw new Error("Cold resume lost session identity or context.");
  }
  console.log(JSON.stringify({ stage: "cold-resume", passed: true, sessionId: nativeId }));
} finally {
  await resumed.close();
}

const missing = await createLocalAgentClient({
  ...options, reuseKey: `agent:main:scout-missing-${randomUUID()}`, warmth: "lazy",
});
try {
  let rejected = false;
  try {
    await missing.turn("This must not start a replacement session.");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("session/resume failed")) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error("Missing continuation unexpectedly succeeded.");
  console.log(JSON.stringify({ stage: "missing-session", passed: true }));
} finally {
  await missing.close();
}
