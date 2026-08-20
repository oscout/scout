import type { RuntimeEnv } from "../portable-types.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CursorTransportAuthSource } from "@openscout/protocol";

export type ResolvedCursorAuth = {
  apiKey?: string;
  source: CursorTransportAuthSource;
};

const API_KEY_FILE = join(homedir(), ".cursor", "api_key.env");

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const index = trimmed.indexOf("=");
  if (index <= 0) {
    return null;
  }
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

export async function resolveCursorApiKey(
  env: RuntimeEnv = process.env,
): Promise<ResolvedCursorAuth> {
  const fromEnv = env.CURSOR_API_KEY?.trim();
  if (fromEnv) {
    return { apiKey: fromEnv, source: "env" };
  }

  if (!existsSync(API_KEY_FILE)) {
    return { source: "none" };
  }

  try {
    const body = await readFile(API_KEY_FILE, "utf8");
    for (const line of body.split("\n")) {
      const parsed = parseEnvLine(line);
      if (parsed?.key === "CURSOR_API_KEY" && parsed.value) {
        return { apiKey: parsed.value, source: "cursor_api_key_file" };
      }
    }
  } catch {
    return { source: "none" };
  }

  return { source: "none" };
}

export function resolveCursorAgentExecutable(env: RuntimeEnv = process.env): string {
  return env.OPENSCOUT_CURSOR_AGENT_BIN?.trim()
    || env.CURSOR_AGENT_BIN?.trim()
    || "cursor-agent";
}
