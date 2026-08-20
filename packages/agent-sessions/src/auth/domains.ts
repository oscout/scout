/**
 * Vendor credential domains and per-harness auth models.
 *
 * The domain table is the authority on which env vars carry a credential. Two
 * consumers derive from it rather than keeping their own copies:
 *
 * - redaction (`secretEnvKeys()`) — every value marked `secret` gets scrubbed;
 * - readiness — a harness is authenticated when any declared credential
 *   resolves.
 *
 * Keeping both derived from one table is the point. The previous hand-written
 * arrays disagreed, and the disagreement is exactly what let
 * `CLAUDE_CODE_OAUTH_TOKEN` — the credential a cloud instance is most likely
 * to hold — go unredacted and unrecognised by readiness at the same time.
 *
 * Not every var here is a secret. AWS regions and Azure endpoint names travel
 * alongside credentials but are configuration; marking them `secret: false`
 * keeps them out of the redaction registry, where a value like `us-east-1`
 * would otherwise be scrubbed out of unrelated log lines.
 */

import type { CredentialDomain, HarnessAuthModel, HarnessCredential } from "./types.js";

function envCredential(
  key: string,
  options: {
    secret?: boolean;
    portable?: boolean;
    readinessSignal?: boolean;
    billing?: "subscription" | "api" | "unknown";
    scoutOwned?: boolean;
    label?: string;
  } = {},
): Extract<HarnessCredential, { kind: "env" }> {
  return {
    kind: "env",
    key,
    secret: options.secret ?? true,
    // An env var is transportable by construction: it is a string you can put
    // in a secret store and inject anywhere. Files and login caches are not.
    portable: options.portable ?? true,
    readinessSignal: options.readinessSignal ?? true,
    ...(options.billing ? { billing: options.billing } : {}),
    ...(options.scoutOwned ? { scoutOwned: true } : {}),
    ...(options.label ? { label: options.label } : {}),
  };
}

/** Configuration that rides along with a credential but is not itself secret. */
function configCredential(key: string): Extract<HarnessCredential, { kind: "env" }> {
  return envCredential(key, { secret: false });
}

export const CREDENTIAL_DOMAINS: Record<string, CredentialDomain> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    env: [
      // `claude setup-token` mints this; it is the subscription-billed path and
      // the one that survives a move to another machine.
      envCredential("CLAUDE_CODE_OAUTH_TOKEN", { billing: "subscription" }),
      // Redacted like any credential, but it cannot authenticate a request on
      // its own, so it must not make a harness look ready.
      envCredential("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", {
        billing: "subscription",
        readinessSignal: false,
      }),
      envCredential("ANTHROPIC_API_KEY", { billing: "api" }),
      envCredential("ANTHROPIC_AUTH_TOKEN", { billing: "api" }),
      envCredential("ANTHROPIC_OAUTH_TOKEN", { billing: "subscription" }),
    ],
  },
  openai: { id: "openai", label: "OpenAI", env: [envCredential("OPENAI_API_KEY")] },
  xai: {
    id: "xai",
    label: "xAI",
    env: [
      envCredential("XAI_API_KEY"),
      envCredential("SCOUT_XAI_API_KEY", { scoutOwned: true }),
    ],
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    env: [
      envCredential("OPENCODE_API_KEY"),
      envCredential("SCOUT_OPENCODE_API_KEY", { scoutOwned: true }),
    ],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    env: [
      envCredential("OPENROUTER_API_KEY"),
      envCredential("SCOUT_OPENROUTER_API_KEY", { scoutOwned: true }),
    ],
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    env: [envCredential("MINIMAX_API_KEY"), envCredential("MINIMAX_TOKEN")],
  },
  gemini: { id: "gemini", label: "Google Gemini", env: [envCredential("GEMINI_API_KEY")] },
  kimi: { id: "kimi", label: "Kimi / Moonshot", env: [envCredential("KIMI_API_KEY")] },
  cursor: {
    id: "cursor",
    label: "Cursor",
    env: [
      envCredential("CURSOR_API_KEY"),
      envCredential("SCOUT_CURSOR_API_KEY", { scoutOwned: true }),
    ],
  },
  groq: { id: "groq", label: "Groq", env: [envCredential("GROQ_API_KEY")] },
  cerebras: { id: "cerebras", label: "Cerebras", env: [envCredential("CEREBRAS_API_KEY")] },
  mistral: { id: "mistral", label: "Mistral", env: [envCredential("MISTRAL_API_KEY")] },
  zai: { id: "zai", label: "Z.ai", env: [envCredential("ZAI_API_KEY")] },
  vercel: { id: "vercel", label: "Vercel AI Gateway", env: [envCredential("AI_GATEWAY_API_KEY")] },
  bedrock: {
    id: "bedrock",
    label: "AWS Bedrock",
    env: [
      envCredential("AWS_ACCESS_KEY_ID"),
      envCredential("AWS_SECRET_ACCESS_KEY"),
      envCredential("AWS_SESSION_TOKEN"),
      configCredential("AWS_REGION"),
      configCredential("AWS_DEFAULT_REGION"),
      configCredential("AWS_PROFILE"),
    ],
  },
  azure: {
    id: "azure",
    label: "Azure OpenAI",
    env: [
      envCredential("AZURE_OPENAI_API_KEY"),
      configCredential("AZURE_OPENAI_BASE_URL"),
      configCredential("AZURE_OPENAI_RESOURCE_NAME"),
      configCredential("AZURE_OPENAI_API_VERSION"),
      configCredential("AZURE_OPENAI_DEPLOYMENT_NAME_MAP"),
    ],
  },
};

function domainEnv(id: string): HarnessCredential[] {
  return CREDENTIAL_DOMAINS[id]?.env ?? [];
}

/**
 * Per-harness auth models.
 *
 * `credentials` is ordered most-preferred-first and mirrors what the harness
 * itself does at runtime, not what we wish it did. Where a vendor's own auth
 * cache outranks an injected env var, the file is listed above the env entry.
 */
export const HARNESS_AUTH_MODELS: Record<string, HarnessAuthModel> = {
  claude: {
    harness: "claude",
    mode: "delegated",
    domains: ["anthropic"],
    credentials: [
      ...domainEnv("anthropic"),
      {
        kind: "file",
        path: "~/.claude/.credentials.json",
        // Keyed to a machine-local interactive OAuth flow — copying it to
        // another box is not a supported path.
        portable: false,
        fileType: "file",
      },
      { kind: "file", path: "~/.claude/sessions", portable: false, fileType: "directory" },
      { kind: "helper", setting: "apiKeyHelper" },
    ],
    login: { command: "claude login", interactive: true },
    provision: {
      command: "claude setup-token",
      yields: "CLAUDE_CODE_OAUTH_TOKEN",
      portable: true,
      note: "Requires a Claude subscription; bills the subscription rather than API rates.",
    },
    notReadyMessage: "Claude is installed but not authenticated yet.",
  },

  opencode: {
    harness: "opencode",
    mode: "hybrid",
    domains: ["opencode"],
    credentials: [
      {
        // Verified precedence: OpenCode reads auth.json ahead of the env var,
        // so a seeded image silently ignores an injected key. Listed first
        // because that is what actually happens, not what is preferable.
        kind: "file",
        path: "~/.local/share/opencode/auth.json",
        portable: false,
        fileType: "file",
      },
      ...domainEnv("opencode"),
    ],
    login: { command: "opencode auth login", interactive: true },
    notReadyMessage:
      "OpenCode is installed but still needs a cached login, OPENCODE_API_KEY, or SCOUT_OPENCODE_API_KEY.",
  },

  grok: {
    harness: "grok",
    mode: "hybrid",
    domains: ["xai"],
    credentials: [
      { kind: "file", path: "~/.grok/auth.json", portable: false, fileType: "file" },
      { kind: "file", path: "~/.grok/sessions", portable: false, fileType: "directory" },
      ...domainEnv("xai"),
    ],
    login: { command: "grok login", interactive: true },
    notReadyMessage: "Grok is installed but not authenticated yet.",
  },
};

/** `grok-acp` is a second catalog entry over the same xAI credential domain. */
HARNESS_AUTH_MODELS["grok-acp"] = {
  ...HARNESS_AUTH_MODELS.grok,
  harness: "grok-acp",
  notReadyMessage: "Grok ACP is installed but still needs a cached login or XAI_API_KEY.",
};

export function harnessAuthModel(harness: string): HarnessAuthModel | undefined {
  return HARNESS_AUTH_MODELS[harness];
}

/**
 * Every env var name that carries a secret, across all domains. This is the
 * redaction contract: a value arriving under one of these names is scrubbed
 * regardless of which harness supplied it.
 */
export function secretEnvKeys(): string[] {
  const keys = new Set<string>();
  for (const domain of Object.values(CREDENTIAL_DOMAINS)) {
    for (const credential of domain.env) {
      if (credential.secret) keys.add(credential.key);
    }
  }
  return [...keys].sort();
}

/**
 * Credentials that survive a move to another machine, with the command that
 * mints one where the harness offers it. This is the seeding manifest for a
 * cloud instance: anything a harness needs that is *not* listed here has no
 * portable form and must be provisioned another way.
 */
export function portableCredentialManifest(): Array<{
  harness: string;
  mode: string;
  portableEnvKeys: string[];
  provisionCommand: string | null;
  unportable: string[];
}> {
  return Object.values(HARNESS_AUTH_MODELS).map((model) => ({
    harness: model.harness,
    mode: model.mode,
    portableEnvKeys: model.credentials
      .filter((credential): credential is Extract<HarnessCredential, { kind: "env" }> =>
        credential.kind === "env" && credential.portable)
      .map((credential) => credential.key),
    provisionCommand: model.provision?.command ?? null,
    unportable: model.credentials
      .filter((credential) => credential.kind === "file" && !credential.portable)
      .map((credential) => (credential.kind === "file" ? credential.path : "")),
  }));
}
