import { describe, expect, test } from "bun:test";

import {
  CREDENTIAL_DOMAINS,
  harnessAuthModel,
  portableCredentialManifest,
  secretEnvKeys,
} from "./index.js";

describe("credential domains", () => {
  test("covers the credential names the redaction bootstrap used to hard-code", () => {
    // The previous hand-maintained array in secret-redaction-bootstrap.ts.
    // Deriving must not lose coverage.
    const previouslyHardCoded = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "XAI_API_KEY",
      "SCOUT_XAI_API_KEY",
      "OPENCODE_API_KEY",
      "SCOUT_OPENCODE_API_KEY",
      "OPENROUTER_API_KEY",
      "MINIMAX_API_KEY",
      "MINIMAX_TOKEN",
      "GEMINI_API_KEY",
      "KIMI_API_KEY",
      "CURSOR_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ];
    const derived = new Set(secretEnvKeys());
    for (const key of previouslyHardCoded) {
      expect(derived.has(key)).toBe(true);
    }
  });

  test("covers the OAuth token the hard-coded list missed", () => {
    // The gap that motivated this module: Claude Code reads
    // CLAUDE_CODE_OAUTH_TOKEN, the hard-coded list named ANTHROPIC_OAUTH_TOKEN,
    // and nothing redacted the credential a cloud instance actually holds.
    const derived = new Set(secretEnvKeys());
    expect(derived.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(derived.has("CLAUDE_CODE_OAUTH_REFRESH_TOKEN")).toBe(true);
    expect(derived.has("ANTHROPIC_AUTH_TOKEN")).toBe(true);
  });

  test("excludes non-credential configuration from the redaction registry", () => {
    // Registering a region would scrub "us-east-1" out of unrelated log lines.
    const derived = new Set(secretEnvKeys());
    for (const key of ["AWS_REGION", "AWS_PROFILE", "AZURE_OPENAI_BASE_URL"]) {
      expect(derived.has(key)).toBe(false);
    }
  });
});

describe("harness auth models", () => {
  test("declares OpenCode's auth.json above the env key", () => {
    // Verified precedence: auth.json wins, so a seeded cloud image silently
    // ignores an injected OPENCODE_API_KEY. Order here is the contract.
    const model = harnessAuthModel("opencode");
    const order = model?.credentials.map((credential) =>
      credential.kind === "file" ? credential.path : credential.kind === "env" ? credential.key : credential.setting);
    expect(order?.[0]).toBe("~/.local/share/opencode/auth.json");
    expect(order?.indexOf("OPENCODE_API_KEY")).toBeGreaterThan(0);
  });

  test("grok and grok-acp share one xAI credential domain", () => {
    expect(harnessAuthModel("grok")?.domains).toEqual(["xai"]);
    expect(harnessAuthModel("grok-acp")?.domains).toEqual(["xai"]);
  });

  test("claude declares a portable provisioning path", () => {
    const model = harnessAuthModel("claude");
    expect(model?.provision?.command).toBe("claude setup-token");
    expect(model?.provision?.yields).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(model?.provision?.portable).toBe(true);
  });

  test("marks login caches unportable so cloud seeding cannot rely on them", () => {
    const claude = harnessAuthModel("claude");
    const credentialsFile = claude?.credentials.find(
      (credential) => credential.kind === "file" && credential.path === "~/.claude/.credentials.json",
    );
    expect(credentialsFile?.kind === "file" && credentialsFile.portable).toBe(false);
  });

  test("refresh tokens are redacted but never signal readiness", () => {
    const refresh = CREDENTIAL_DOMAINS.anthropic.env.find(
      (credential) => credential.key === "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    );
    expect(refresh?.secret).toBe(true);
    expect(refresh?.readinessSignal).toBe(false);
  });

  test("produces a seeding manifest for cloud instances", () => {
    const manifest = portableCredentialManifest();
    const claude = manifest.find((entry) => entry.harness === "claude");
    expect(claude?.portableEnvKeys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claude?.provisionCommand).toBe("claude setup-token");
    expect(claude?.unportable).toContain("~/.claude/.credentials.json");
  });
});
