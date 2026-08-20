import { appendFileSync, mkdirSync } from "node:fs";

import { pairingPaths } from "./config";

export type PairingLogLevel = "debug" | "info" | "warn" | "error";

function write(level: PairingLogLevel, category: string, message: string, data?: unknown) {
  const { rootDir, logPath } = pairingPaths();
  mkdirSync(rootDir, { recursive: true });
  const prefix = `${new Date().toISOString()} [${level.toUpperCase()}] [${category}]`;
  const line = data === undefined
    ? `${prefix} ${message}\n`
    : `${prefix} ${message} ${JSON.stringify(data)}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // Ignore logging failures.
  }
}

export const pairingLog = {
  debug: (category: string, message: string, data?: unknown) => write("debug", category, message, data),
  info: (category: string, message: string, data?: unknown) => write("info", category, message, data),
  warn: (category: string, message: string, data?: unknown) => write("warn", category, message, data),
  error: (category: string, message: string, data?: unknown) => write("error", category, message, data),
};
