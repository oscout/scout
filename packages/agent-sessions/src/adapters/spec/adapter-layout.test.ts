import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_PACKAGE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const RUNTIME_ADAPTERS = [
  "acp",
  "claude-code",
  "codex",
  "echo",
  "grok-acp",
  "kimi-acp",
  "openai-compat",
  "opencode",
  "opencode-v2",
  "pi",
] as const;

function collectSpecFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSpecFiles(entryPath));
    } else if (entry.isFile() && entry.name === "adapter.spec.json") {
      files.push(entryPath);
    }
  }
  return files;
}

describe("adapter layout", () => {
  test("runtime adapters use directory-owned entrypoints", () => {
    for (const adapterId of RUNTIME_ADAPTERS) {
      const adapterDirectory = join(ADAPTER_ROOT, adapterId);
      expect(existsSync(join(adapterDirectory, "adapter.ts"))).toBe(true);
      expect(existsSync(join(adapterDirectory, "index.ts"))).toBe(true);
      expect(readFileSync(join(adapterDirectory, "index.ts"), "utf8")).toContain("./adapter.js");
    }
  });

  test("adapter specs point at checked-in files", () => {
    for (const specFile of collectSpecFiles(ADAPTER_ROOT)) {
      const spec = JSON.parse(readFileSync(specFile, "utf8")) as {
        implementation?: { entrypoint?: string };
        upstream?: { sources?: Array<{ kind?: string; ref?: string }> };
      };

      const entrypoint = spec.implementation?.entrypoint;
      expect(typeof entrypoint).toBe("string");
      expect(existsSync(join(REPO_PACKAGE_ROOT, entrypoint!))).toBe(true);

      for (const source of spec.upstream?.sources ?? []) {
        if (source.kind !== "file") {
          continue;
        }
        expect(existsSync(join(REPO_PACKAGE_ROOT, source.ref ?? ""))).toBe(true);
      }
    }
  });
});
