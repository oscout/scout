import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeConfigFilePath, isClaudeFolderTrusted } from "./claude-folder-trust.js";

const scratch: string[] = [];

function fixture(projects: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "claude-trust-"));
  scratch.push(root);
  const configPath = join(root, ".claude.json");
  writeFileSync(configPath, JSON.stringify({ projects }));
  return { root, configPath };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isClaudeFolderTrusted", () => {
  test("trusts a folder Claude accepted, and its descendants", () => {
    const { configPath } = fixture({ "/Users/me/dev": { hasTrustDialogAccepted: true } });
    expect(isClaudeFolderTrusted("/Users/me/dev", { configPath })).toBe(true);
    expect(isClaudeFolderTrusted("/Users/me/dev/app/src", { configPath })).toBe(true);
  });

  test("does not trust a folder Claude has only seen, or never seen", () => {
    const { configPath } = fixture({ "/Users/me": { hasTrustDialogAccepted: false } });
    expect(isClaudeFolderTrusted("/Users/me/Library/Application Support/Linea/Scout", { configPath })).toBe(false);
  });

  test("treats a missing or unreadable config as untrusted", () => {
    expect(isClaudeFolderTrusted("/Users/me/dev", { configPath: "/nonexistent/.claude.json" })).toBe(false);
    expect(isClaudeFolderTrusted("/Users/me/dev", { readConfig: () => "{not json" })).toBe(false);
  });

  test("matches the resolved path, so /var/folders and /private/var/folders agree", () => {
    const { root, configPath } = fixture({});
    const real = join(root, "real");
    mkdirSync(real);
    const { configPath: trusted } = fixture({ [realpathSync(real)]: { hasTrustDialogAccepted: true } });
    expect(isClaudeFolderTrusted(real, { configPath })).toBe(false);
    expect(isClaudeFolderTrusted(real, { configPath: trusted })).toBe(true);
  });

  test("honors CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigFilePath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/.claude.json");
  });
});
