import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const NORMALIZER_MODULES = [
  "protocol/normalizer.ts",
  "adapters/echo/normalizer.ts",
  "adapters/codex/normalizer.ts",
  "adapters/claude-code/normalizer.ts",
  "adapters/opencode-v2/normalizer.ts",
];

const FORBIDDEN = [
  /from\s+["']node:fs["']/,
  /from\s+["']node:fs\/promises["']/,
  /from\s+["']node:child_process["']/,
  /from\s+["']node:net["']/,
  /from\s+["']node:http["']/,
  /from\s+["']node:https["']/,
  /from\s+["']node:os["']/,
  /from\s+["']bun:sqlite["']/,
  /\bprocess\.env\b/,
  /\bprocess\.stdin\b/,
  /\bprocess\.stdout\b/,
  /\bprocess\.cwd\s*\(/,
  /\bspawn\s*\(/,
  /\bfetch\s*\(/,
];

describe("SCO-042 normalizer purity (C011)", () => {
  for (const relativePath of NORMALIZER_MODULES) {
    test(`${relativePath} has no process/fs/network/env side-effect imports`, () => {
      const source = readFileSync(join(ROOT, relativePath), "utf8");
      for (const pattern of FORBIDDEN) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});
