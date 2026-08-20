import type { RuntimeEnv, RuntimePlatform } from "./portable-types.js";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveCodexExecutableInventory, type CodexExecutableCandidate } from "@openscout/agent-sessions/codex-executable";
import { harnessAuthModel } from "@openscout/agent-sessions/auth";
import type { AgentCapability, AgentHarness } from "@openscout/protocol";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export const HARNESS_CATALOG_VERSION = 1;

export type HarnessCatalogSupport = {
  install: boolean;
  workspace: boolean;
  collaboration: boolean;
  browser: boolean;
  files: boolean;
  tunnels: boolean;
  onboarding: boolean;
};

export type HarnessRequirement =
  | {
    kind: "env";
    key: string;
    label?: string;
  }
  | {
    kind: "file";
    path: string;
    label?: string;
    fileType?: "file" | "directory" | "any";
  };

export type HarnessInstallSpec = {
  binary?: string;
  requires?: string[];
  macos?: string;
  linux?: string;
  windows?: string;
  verify?: string;
  verifyWin?: string;
};

export type HarnessReadinessConfig = {
  allOf?: HarnessRequirement[];
  anyOf?: HarnessRequirement[];
  healthcheckCommand?: string;
  loginCommand?: string;
  notReadyMessage?: string;
};

export type HarnessSessionDefaults = {
  /** Canonical harness/adapter used when this catalog entry is selected. */
  defaultHarness?: AgentHarness | (string & {});
  defaultTransport: string;
  fallbackTransports?: string[];
};

export type HarnessCatalogEntry = {
  name: string;
  harness: AgentHarness | (string & {});
  label: string;
  description: string;
  homepage?: string;
  tags: string[];
  featured?: boolean;
  order?: number;
  support: HarnessCatalogSupport;
  install?: HarnessInstallSpec;
  readiness?: HarnessReadinessConfig;
  launch?: {
    args: string[];
  };
  resume?: {
    command: string;
    sessionFlag: string;
    cwdFlag?: string;
  };
  sessionDefaults?: HarnessSessionDefaults;
  resolveEnv?: Array<{ from: string; to: string }>;
  capabilities: AgentCapability[];
  metadata?: Record<string, string | number | boolean | null>;
};

export type HarnessCatalogOverride = Partial<Omit<HarnessCatalogEntry, "support" | "install" | "readiness" | "launch" | "resume" | "sessionDefaults">> & {
  support?: Partial<HarnessCatalogSupport>;
  install?: Partial<HarnessInstallSpec>;
  readiness?: Partial<HarnessReadinessConfig>;
  launch?: Partial<HarnessCatalogEntry["launch"]>;
  resume?: Partial<HarnessCatalogEntry["resume"]>;
  sessionDefaults?: Partial<HarnessSessionDefaults>;
};

export type HarnessCatalogOverrideRecord = {
  version: typeof HARNESS_CATALOG_VERSION;
  entries: Record<string, HarnessCatalogOverride>;
  updatedAt?: string;
};

export type HarnessReadinessState = "ready" | "configured" | "installed" | "missing";

export type HarnessReadinessReport = {
  state: HarnessReadinessState;
  installed: boolean;
  configured: boolean;
  ready: boolean;
  detail: string;
  missing: string[];
  binaryPath: string | null;
  binaryVersion?: string | null;
  binarySource?: string | null;
  binaryCandidates?: HarnessBinaryCandidateReport[];
  loginCommand: string | null;
};

export type HarnessBinaryCandidateReport = {
  path: string;
  source: string;
  executable: boolean;
  version: string | null;
  selected: boolean;
};

export type ResolvedHarnessCatalogEntry = HarnessCatalogEntry & {
  source: "builtin" | "local";
  readinessReport: HarnessReadinessReport;
};

export type HarnessCatalogSnapshot = {
  version: typeof HARNESS_CATALOG_VERSION;
  generatedAt: number;
  entries: ResolvedHarnessCatalogEntry[];
};

export type HarnessCatalogLoadOptions = {
  env?: RuntimeEnv;
  platform?: RuntimePlatform;
  overridePath?: string;
  now?: () => number;
  whichBinary?: (binary: string) => string | null;
  requirementExists?: (requirement: Extract<HarnessRequirement, { kind: "file" }>) => boolean;
  runCommand?: (command: string) => boolean;
};

const DEFAULT_SUPPORT: HarnessCatalogSupport = {
  install: true,
  workspace: false,
  collaboration: false,
  browser: false,
  files: false,
  tunnels: false,
  onboarding: true,
};

/**
 * Derive a readiness config from the harness auth model
 * (`@openscout/agent-sessions/auth`), so credentials are declared once and
 * both readiness and redaction read the same list.
 *
 * Hand-written `anyOf` arrays drifted from what the harnesses actually read:
 * Claude's omitted `CLAUDE_CODE_OAUTH_TOKEN`, so a machine authenticated via
 * `claude setup-token` — the portable, subscription-billed path — reported as
 * not authenticated. Deriving keeps the two in step.
 *
 * `helper` credentials (Claude Code's `apiKeyHelper`) are skipped: they name a
 * command that returns a key rather than something whose presence is testable
 * here. Values that are not readiness signals on their own (refresh tokens)
 * are skipped too, while remaining subject to redaction.
 */
function readinessFromAuthModel(harness: string): HarnessReadinessConfig | undefined {
  const model = harnessAuthModel(harness);
  if (!model) return undefined;

  const anyOf: HarnessRequirement[] = [];
  for (const credential of model.credentials) {
    if (credential.kind === "env") {
      if (credential.readinessSignal === false) continue;
      anyOf.push({ kind: "env", key: credential.key });
    } else if (credential.kind === "file") {
      anyOf.push({
        kind: "file",
        path: credential.path,
        label: credential.label ?? credential.path,
        ...(credential.fileType ? { fileType: credential.fileType } : {}),
      });
    }
  }
  if (anyOf.length === 0) return undefined;

  return {
    anyOf,
    ...(model.login ? { loginCommand: model.login.command } : {}),
    ...(model.notReadyMessage ? { notReadyMessage: model.notReadyMessage } : {}),
  };
}

const BUILT_IN_HARNESS_CATALOG: HarnessCatalogEntry[] = [
  {
    name: "claude",
    harness: "claude",
    label: "Claude Code",
    description: "Anthropic's CLI coding agent",
    homepage: "https://claude.ai/claude-code",
    tags: ["coding", "cli", "anthropic"],
    featured: true,
    order: 1,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
    },
    install: {
      binary: "claude",
      requires: ["node"],
      macos: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      windows: "npm install -g @anthropic-ai/claude-code",
    },
    readiness: readinessFromAuthModel("claude"),
    resume: {
      command: "claude",
      sessionFlag: "--resume",
    },
    sessionDefaults: {
      defaultTransport: "tmux",
      fallbackTransports: ["claude_stream_json"],
    },
    capabilities: ["chat", "invoke", "deliver", "summarize", "review"],
  },
  {
    name: "grok",
    harness: "grok",
    label: "Grok CLI",
    description: "xAI's interactive Grok CLI coding agent",
    homepage: "https://grok.com",
    tags: ["coding", "cli", "xai", "grok"],
    featured: true,
    order: 2,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
    },
    install: {
      binary: "grok",
      requires: ["curl"],
      macos: "curl -fsSL https://grok.com/install.sh | bash",
      linux: "curl -fsSL https://grok.com/install.sh | bash",
    },
    readiness: readinessFromAuthModel("grok"),
    resume: {
      command: "grok",
      sessionFlag: "--resume",
    },
    sessionDefaults: {
      defaultHarness: "grok-acp",
      defaultTransport: "grok_acp",
    },
    capabilities: ["chat", "invoke", "deliver", "summarize", "review"],
    metadata: {
      invocationModel: "tmux_interactive",
    },
  },
  {
    name: "codex",
    harness: "codex",
    label: "Codex",
    description: "OpenAI's CLI coding agent",
    homepage: "https://github.com/openai/codex",
    tags: ["coding", "cli", "openai"],
    featured: true,
    order: 3,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
    },
    install: {
      binary: "codex",
      requires: ["node"],
      macos: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      windows: "npm install -g @openai/codex",
    },
    readiness: {
      anyOf: [
        { kind: "env", key: "OPENAI_API_KEY" },
        { kind: "file", path: "~/.codex/auth.json", label: "~/.codex/auth.json", fileType: "file" },
      ],
      loginCommand: "codex login",
      notReadyMessage: "Codex is installed but not authenticated yet.",
    },
    resume: {
      command: "codex",
      sessionFlag: "resume",
      cwdFlag: "-C",
    },
    sessionDefaults: {
      defaultTransport: "codex_app_server",
    },
    capabilities: ["chat", "invoke", "deliver", "review", "execute"],
  },
  {
    name: "grok-acp",
    harness: "grok-acp",
    label: "Grok ACP",
    description: "xAI's Grok CLI coding agent over ACP",
    homepage: "https://docs.x.ai/build/overview",
    tags: ["coding", "cli", "xai", "acp"],
    featured: true,
    order: 3,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
      files: true,
    },
    install: {
      binary: "grok",
      macos: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
      windows: "irm https://x.ai/cli/install.ps1 | iex",
    },
    readiness: readinessFromAuthModel("grok-acp"),
    sessionDefaults: {
      defaultTransport: "grok_acp",
    },
    capabilities: ["chat", "invoke", "deliver", "review", "execute"],
    metadata: {
      adapterType: "grok-acp",
      transport: "acp_stdio",
    },
  },
  {
    name: "kimi",
    harness: "kimi",
    label: "Kimi Code",
    description: "Kimi Code CLI coding agent over ACP",
    homepage: "https://www.kimi.com/code/docs/en/",
    tags: ["coding", "cli", "kimi", "moonshot", "acp"],
    featured: true,
    order: 4,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
      files: true,
    },
    install: {
      binary: "kimi",
      requires: ["curl"],
      macos: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      linux: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      windows: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    },
    readiness: {
      anyOf: [
        { kind: "file", path: "~/.kimi-code/credentials", label: "~/.kimi-code/credentials", fileType: "directory" },
      ],
      loginCommand: "kimi login",
      notReadyMessage: "Kimi Code is installed but still needs a cached login from kimi login.",
    },
    sessionDefaults: {
      defaultTransport: "kimi_acp",
    },
    capabilities: ["chat", "invoke", "deliver", "review", "execute"],
    metadata: {
      adapterType: "kimi-acp",
      transport: "acp_stdio",
    },
  },
  {
    name: "opencode",
    harness: "opencode",
    label: "OpenCode",
    description: "OpenCode's coding agent over ACP, fronting many model vendors via OpenCode Zen",
    homepage: "https://opencode.ai/docs/",
    tags: ["coding", "cli", "opencode", "acp"],
    featured: true,
    order: 4,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
      files: true,
    },
    install: {
      binary: "opencode",
      requires: ["curl"],
      macos: "curl -fsSL https://opencode.ai/install | bash",
      linux: "curl -fsSL https://opencode.ai/install | bash",
      windows: "irm https://opencode.ai/install.ps1 | iex",
    },
    readiness: readinessFromAuthModel("opencode"),
    resume: {
      command: "opencode",
      sessionFlag: "--session",
    },
    sessionDefaults: {
      defaultTransport: "opencode_acp",
    },
    capabilities: ["chat", "invoke", "deliver", "review", "execute"],
    metadata: {
      adapterType: "opencode-acp",
      transport: "acp_stdio",
    },
  },
  {
    name: "cursor",
    harness: "cursor",
    label: "Cursor CLI",
    description: "Cursor's coding agent over its official ACP stdio interface",
    homepage: "https://cursor.com/docs/cli/acp",
    tags: ["coding", "cli", "cursor", "acp"],
    featured: true,
    order: 4,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
      files: true,
    },
    install: {
      binary: "cursor-agent",
      requires: ["curl"],
      macos: "curl -fsSL https://cursor.com/install | bash",
      linux: "curl -fsSL https://cursor.com/install | bash",
      windows: "irm 'https://cursor.com/install?win32=true' | iex",
      verify: "cursor-agent --version >/dev/null 2>&1",
    },
    readiness: {
      healthcheckCommand: "cursor-agent status >/dev/null 2>&1",
      loginCommand: "cursor-agent login",
      notReadyMessage: "Cursor CLI is installed but still needs cursor-agent login or CURSOR_API_KEY.",
    },
    sessionDefaults: {
      defaultTransport: "cursor_acp",
    },
    capabilities: ["chat", "invoke", "deliver", "review", "execute"],
    metadata: {
      adapterType: "cursor-acp",
      transport: "acp_stdio",
    },
  },
  {
    name: "flue",
    harness: "flue",
    label: "Flue",
    description: "Agentic runtime and execution harness from the Astro ecosystem",
    tags: ["agent-runtime", "cli", "orchestration"],
    featured: true,
    order: 5,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
      files: true,
    },
    install: {
      binary: "flue",
      requires: ["bun"],
    },
    readiness: {
      anyOf: [
        { kind: "env", key: "MINIMAX_API_KEY" },
        { kind: "env", key: "ANTHROPIC_API_KEY" },
        { kind: "env", key: "OPENAI_API_KEY" },
        { kind: "env", key: "OPENROUTER_API_KEY" },
      ],
      notReadyMessage: "Flue is installed but no provider API key is configured yet.",
    },
    capabilities: ["chat", "invoke", "deliver", "review", "execute"],
    metadata: {
      invocationModel: "runtime_managed",
    },
  },
  {
    name: "pi",
    harness: "pi",
    label: "Pi",
    description: "pi.dev's CLI coding agent with provider and extension support",
    homepage: "https://pi.dev/docs/latest/quickstart",
    tags: ["coding", "cli", "pi"],
    featured: true,
    order: 6,
    support: {
      ...DEFAULT_SUPPORT,
      workspace: true,
      collaboration: true,
      files: true,
    },
    install: {
      binary: "pi",
      requires: ["node"],
      macos: "npm install -g @earendil-works/pi-coding-agent",
      linux: "npm install -g @earendil-works/pi-coding-agent",
      windows: "npm install -g @earendil-works/pi-coding-agent",
    },
    readiness: {
      anyOf: [
        { kind: "file", path: "~/.pi/agent/auth.json", label: "~/.pi/agent/auth.json", fileType: "file" },
        { kind: "env", key: "ANTHROPIC_API_KEY" },
        { kind: "env", key: "OPENAI_API_KEY" },
        { kind: "env", key: "OPENROUTER_API_KEY" },
        { kind: "env", key: "XAI_API_KEY" },
        { kind: "env", key: "SCOUT_XAI_API_KEY" },
        { kind: "env", key: "MINIMAX_API_KEY" },
        { kind: "env", key: "GEMINI_API_KEY" },
      ],
      loginCommand: "pi /login",
      notReadyMessage: "Pi is installed but still needs a subscription login, API key, or auth file.",
    },
    resume: {
      command: "pi",
      sessionFlag: "--resume",
    },
    capabilities: ["chat", "invoke", "deliver", "review", "execute"],
  },
];

function expandHomePath(value: string): string {
  const home = process.env.HOME?.trim() || homedir();
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function defaultWhichBinary(binary: string, platform: RuntimePlatform): string | null {
  try {
    const command = platform === "win32" ? "where" : "sh";
    const args = platform === "win32"
      ? [binary]
      : ["-lc", `command -v ${JSON.stringify(binary)}`];
    const raw = execFileSync(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return raw.split(/\r?\n/).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function defaultRunCommand(command: string, platform: RuntimePlatform): boolean {
  try {
    if (platform === "win32") {
      execFileSync("cmd.exe", ["/d", "/s", "/c", command], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    }
    execFileSync("sh", ["-lc", command], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function defaultRequirementExists(requirement: Extract<HarnessRequirement, { kind: "file" }>): boolean {
  const expanded = expandHomePath(requirement.path);
  if (!existsSync(expanded)) return false;
  if (requirement.fileType === "any" || !requirement.fileType) return true;

  try {
    const fileStat = statSync(expanded);
    return requirement.fileType === "directory" ? fileStat.isDirectory() : fileStat.isFile();
  } catch {
    return false;
  }
}

function mergeSupport(
  base: HarnessCatalogSupport,
  override?: Partial<HarnessCatalogSupport>,
): HarnessCatalogSupport {
  return {
    ...base,
    ...(override ?? {}),
  };
}

function mergeInstall(
  base?: HarnessInstallSpec,
  override?: Partial<HarnessInstallSpec>,
): HarnessInstallSpec | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergeReadiness(
  base?: HarnessReadinessConfig,
  override?: Partial<HarnessReadinessConfig>,
): HarnessReadinessConfig | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergeLaunch(
  base?: HarnessCatalogEntry["launch"],
  override?: Partial<HarnessCatalogEntry["launch"]>,
): HarnessCatalogEntry["launch"] | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? { args: [] }),
    ...(override ?? {}),
    args: override?.args ?? base?.args ?? [],
  };
}

function mergeSessionDefaults(
  base?: HarnessSessionDefaults,
  override?: Partial<HarnessSessionDefaults>,
): HarnessSessionDefaults | undefined {
  const defaultTransport = override?.defaultTransport ?? base?.defaultTransport;
  if (!defaultTransport) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
    defaultTransport,
    fallbackTransports: override?.fallbackTransports
      ? [...override.fallbackTransports]
      : base?.fallbackTransports
        ? [...base.fallbackTransports]
        : undefined,
  };
}

function formatRequirement(requirement: HarnessRequirement): string {
  if (requirement.label?.trim()) return requirement.label.trim();
  if (requirement.kind === "env") return requirement.key;
  return requirement.path;
}

function evaluateRequirement(
  requirement: HarnessRequirement,
  options: Required<Pick<HarnessCatalogLoadOptions, "env" | "requirementExists">>,
): boolean {
  if (requirement.kind === "env") {
    return Boolean(options.env[requirement.key]?.trim());
  }
  return options.requirementExists(requirement);
}

function supportSummaryText(entry: HarnessCatalogEntry): string {
  const enabled = Object.entries(entry.support)
    .filter(([key, enabledFlag]) => enabledFlag && key !== "install" && key !== "onboarding")
    .map(([key]) => key);
  return enabled.length > 0 ? enabled.join(", ") : "general use";
}

function codexCandidateReport(
  candidate: CodexExecutableCandidate,
  selectedPath: string,
): HarnessBinaryCandidateReport {
  return {
    path: candidate.path,
    source: candidate.source,
    executable: candidate.executable,
    version: candidate.version,
    selected: candidate.path === selectedPath,
  };
}

export function buildHarnessResumeCommand(
  entry: HarnessCatalogEntry,
  sessionId: string,
  cwd?: string,
): string | null {
  if (!entry.resume) return null;
  const parts = [entry.resume.command, entry.resume.sessionFlag];
  if (cwd && entry.resume.cwdFlag) {
    parts.push(entry.resume.cwdFlag, expandHomePath(cwd));
  }
  parts.push(sessionId);
  return parts.map(shellQuoteArg).join(" ");
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:+=@%-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function findHarnessEntry(
  harness: string | null | undefined,
): HarnessCatalogEntry | null {
  if (!harness) return null;
  return BUILT_IN_HARNESS_CATALOG.find((e) => e.harness === harness || e.name === harness) ?? null;
}

export function resolveHarnessSessionDefaults(
  harness: string | null | undefined,
  options: {
    transportOverride?: string;
    entries?: readonly HarnessCatalogEntry[];
  } = {},
): { harness: string; transport: string; fallbackTransports: string[] } | null {
  if (!harness) return null;
  const entry = (options.entries ?? BUILT_IN_HARNESS_CATALOG)
    .find((candidate) => candidate.harness === harness || candidate.name === harness);
  const defaults = entry?.sessionDefaults;
  if (!entry || !defaults) return null;

  const fallbackTransports = [...(defaults.fallbackTransports ?? [])];
  const supportedTransports = new Set([defaults.defaultTransport, ...fallbackTransports]);
  const requestedTransport = options.transportOverride?.trim();
  return {
    harness: String(defaults.defaultHarness ?? entry.harness),
    transport: requestedTransport && supportedTransports.has(requestedTransport)
      ? requestedTransport
      : defaults.defaultTransport,
    fallbackTransports,
  };
}

export function createBuiltInHarnessCatalog(): HarnessCatalogEntry[] {
  return BUILT_IN_HARNESS_CATALOG.map((entry) => ({
    ...entry,
    tags: [...entry.tags],
    support: { ...entry.support },
    install: entry.install ? { ...entry.install, requires: [...(entry.install.requires ?? [])] } : undefined,
    readiness: entry.readiness
      ? {
        ...entry.readiness,
        allOf: entry.readiness.allOf ? [...entry.readiness.allOf] : undefined,
        anyOf: entry.readiness.anyOf ? [...entry.readiness.anyOf] : undefined,
      }
      : undefined,
    launch: entry.launch ? { ...entry.launch, args: [...entry.launch.args] } : undefined,
    resume: entry.resume ? { ...entry.resume } : undefined,
    sessionDefaults: entry.sessionDefaults
      ? {
        ...entry.sessionDefaults,
        fallbackTransports: entry.sessionDefaults.fallbackTransports
          ? [...entry.sessionDefaults.fallbackTransports]
          : undefined,
      }
      : undefined,
    resolveEnv: entry.resolveEnv ? [...entry.resolveEnv] : undefined,
    capabilities: [...entry.capabilities],
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  }));
}

export function mergeHarnessCatalogEntries(
  baseEntries: HarnessCatalogEntry[],
  overrides: Record<string, HarnessCatalogOverride> = {},
): HarnessCatalogEntry[] {
  const mergedEntries = baseEntries.map((entry) => {
    const override = overrides[entry.name];
    if (!override) return entry;

    return {
      ...entry,
      ...override,
      support: mergeSupport(entry.support, override.support),
      install: mergeInstall(entry.install, override.install),
      readiness: mergeReadiness(entry.readiness, override.readiness),
      launch: mergeLaunch(entry.launch, override.launch),
      sessionDefaults: mergeSessionDefaults(entry.sessionDefaults, override.sessionDefaults),
      resume: override.resume && entry.resume
        ? { ...entry.resume, ...override.resume }
        : entry.resume,
      tags: override.tags ? [...override.tags] : entry.tags,
      capabilities: override.capabilities ? [...override.capabilities] : entry.capabilities,
      resolveEnv: override.resolveEnv ? [...override.resolveEnv] : entry.resolveEnv,
      metadata: {
        ...(entry.metadata ?? {}),
        ...(override.metadata ?? {}),
      },
    };
  });

  for (const [name, override] of Object.entries(overrides)) {
    if (mergedEntries.some((entry) => entry.name === name)) continue;
    if (!override.label || !override.description || !override.harness || !override.tags || !override.capabilities) {
      continue;
    }
    mergedEntries.push({
      name,
      harness: override.harness,
      label: override.label,
      description: override.description,
      homepage: override.homepage,
      tags: [...override.tags],
      featured: override.featured,
      order: override.order,
      support: mergeSupport(DEFAULT_SUPPORT, override.support),
      install: mergeInstall(undefined, override.install),
      readiness: mergeReadiness(undefined, override.readiness),
      launch: mergeLaunch(undefined, override.launch),
      resume: override.resume?.command && override.resume?.sessionFlag
        ? { command: override.resume.command, sessionFlag: override.resume.sessionFlag, cwdFlag: override.resume.cwdFlag }
        : undefined,
      sessionDefaults: mergeSessionDefaults(undefined, override.sessionDefaults),
      resolveEnv: override.resolveEnv ? [...override.resolveEnv] : undefined,
      capabilities: [...override.capabilities],
      metadata: override.metadata ? { ...override.metadata } : undefined,
    });
  }

  return mergedEntries.sort((lhs, rhs) => {
    const lhsFeatured = lhs.featured ? 1 : 0;
    const rhsFeatured = rhs.featured ? 1 : 0;
    if (lhsFeatured !== rhsFeatured) return rhsFeatured - lhsFeatured;
    if (lhsFeatured && rhsFeatured) return (lhs.order ?? 999) - (rhs.order ?? 999);
    return lhs.label.localeCompare(rhs.label);
  });
}

export function evaluateHarnessReadiness(
  entry: HarnessCatalogEntry,
  options: HarnessCatalogLoadOptions = {},
): HarnessReadinessReport {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const whichBinary = options.whichBinary ?? ((binary: string) => defaultWhichBinary(binary, platform));
  const requirementExists = options.requirementExists ?? defaultRequirementExists;
  const runCommand = options.runCommand ?? ((command: string) => defaultRunCommand(command, platform));

  const binary = entry.install?.binary;
  const codexInventory = entry.name === "codex" && !options.whichBinary
    ? resolveCodexExecutableInventory(env)
    : null;
  const binaryPath = codexInventory
    ? codexInventory.selectedPath
    : (binary ? whichBinary(binary) : null);
  const verifyCommand = platform === "win32"
    ? entry.install?.verifyWin ?? entry.install?.verify
    : entry.install?.verify;
  const verifiedInstall = verifyCommand ? runCommand(verifyCommand) : null;
  const installed = binary
    ? Boolean(binaryPath || verifiedInstall)
    : verifiedInstall ?? true;

  const missing: string[] = [];
  const readiness = entry.readiness;

  if (installed && readiness?.allOf) {
    for (const requirement of readiness.allOf) {
      if (!evaluateRequirement(requirement, { env, requirementExists })) {
        missing.push(formatRequirement(requirement));
      }
    }
  }

  if (installed && readiness?.anyOf && readiness.anyOf.length > 0) {
    const anySatisfied = readiness.anyOf.some((requirement) => evaluateRequirement(requirement, { env, requirementExists }));
    if (!anySatisfied) {
      missing.push(`one of: ${readiness.anyOf.map((requirement) => formatRequirement(requirement)).join(", ")}`);
    }
  }

  const configured = installed && missing.length === 0;
  const healthcheckPassed = configured && readiness?.healthcheckCommand
    ? runCommand(readiness.healthcheckCommand)
    : configured;
  const ready = configured && healthcheckPassed;

  let state: HarnessReadinessState;
  let detail: string;

  if (!installed) {
    state = "missing";
    detail = binary
      ? `${entry.label} is not installed yet.`
      : `${entry.label} is not available yet.`;
  } else if (!configured) {
    state = "installed";
    detail = readiness?.notReadyMessage
      ?? `${entry.label} is installed but still needs configuration.`;
  } else if (!ready) {
    state = "configured";
    detail = `${entry.label} is configured but its readiness check is failing.`;
  } else {
    state = "ready";
    detail = `${entry.label} is ready for ${supportSummaryText(entry)}.`;
  }

  return {
    state,
    installed,
    configured,
    ready,
    detail,
    missing,
    binaryPath,
    binaryVersion: codexInventory?.selected?.version ?? null,
    binarySource: codexInventory?.selected?.source ?? null,
    binaryCandidates: codexInventory?.candidates.map((candidate: CodexExecutableCandidate) =>
      codexCandidateReport(candidate, codexInventory.selectedPath)
    ),
    loginCommand: readiness?.loginCommand ?? null,
  };
}

export async function readHarnessCatalogOverrides(
  overridePath = resolveOpenScoutSupportPaths().harnessCatalogPath,
): Promise<Record<string, HarnessCatalogOverride>> {
  try {
    const raw = JSON.parse(await readFile(overridePath, "utf8")) as HarnessCatalogOverrideRecord;
    return raw.entries ?? {};
  } catch {
    return {};
  }
}

export async function writeHarnessCatalogOverrides(
  overrides: Record<string, HarnessCatalogOverride>,
  overridePath = resolveOpenScoutSupportPaths().harnessCatalogPath,
): Promise<void> {
  await mkdir(dirname(overridePath), { recursive: true });
  const payload: HarnessCatalogOverrideRecord = {
    version: HARNESS_CATALOG_VERSION,
    entries: overrides,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(overridePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export async function ensureHarnessCatalogOverrideFile(
  overridePath = resolveOpenScoutSupportPaths().harnessCatalogPath,
): Promise<void> {
  if (existsSync(overridePath)) return;
  await writeHarnessCatalogOverrides({}, overridePath);
}

export async function loadHarnessCatalogSnapshot(
  options: HarnessCatalogLoadOptions = {},
): Promise<HarnessCatalogSnapshot> {
  const overrides = await readHarnessCatalogOverrides(options.overridePath);
  const entries = mergeHarnessCatalogEntries(createBuiltInHarnessCatalog(), overrides)
    .map((entry) => {
      const source: ResolvedHarnessCatalogEntry["source"] = overrides[entry.name] ? "local" : "builtin";
      return {
        ...entry,
        source,
        readinessReport: evaluateHarnessReadiness(entry, options),
      };
    });

  return {
    version: HARNESS_CATALOG_VERSION,
    generatedAt: (options.now ?? Date.now)(),
    entries,
  };
}
