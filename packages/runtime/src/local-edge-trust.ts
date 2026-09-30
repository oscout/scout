import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The local edge serves https with Caddy's own local CA (`tls internal`).
// Browsers only accept those certificates once this Mac trusts the CA root,
// and only a secure page may use the microphone — so this is what makes live
// voice work on a named host like arts-mini.scout.local.

export type ScoutLocalEdgeTrustStatus = "trusted" | "installed" | "untrusted" | "unavailable" | "skipped" | "error";

export type ScoutLocalEdgeTrustReport = {
  status: ScoutLocalEdgeTrustStatus;
  rootCertificatePath: string;
  trustCommand: string | null;
  detail: string;
};

export type ScoutLocalEdgeTrustCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type ScoutLocalEdgeTrustRunCommand = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => ScoutLocalEdgeTrustCommandResult;

export type ScoutLocalEdgeTrustOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: ScoutLocalEdgeTrustRunCommand;
};

const MACOS_TRUST_COMMAND_LABEL = "security add-trusted-cert";
const TRUST_PROMPT_TIMEOUT_MS = 120_000;

function defaultRunCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): ScoutLocalEdgeTrustCommandResult {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

export function resolveScoutLocalEdgeRootCertificatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.HOME?.trim() || homedir(),
    "Library",
    "Application Support",
    "Caddy",
    "pki",
    "authorities",
    "local",
    "root.crt",
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderMacosTrustScript(rootCertificatePath: string): string {
  const command = [
    "security",
    "add-trusted-cert",
    "-d",
    "-r",
    "trustRoot",
    "-k",
    "/Library/Keychains/System.keychain",
    shellQuote(rootCertificatePath),
  ].join(" ");
  return `do shell script ${JSON.stringify(command)} with administrator privileges`;
}

export function inspectScoutLocalEdgeTrust(options: ScoutLocalEdgeTrustOptions = {}): ScoutLocalEdgeTrustReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const rootCertificatePath = resolveScoutLocalEdgeRootCertificatePath(env);
  const trustCommand = platform === "darwin" ? MACOS_TRUST_COMMAND_LABEL : "caddy trust";

  if (!existsSync(rootCertificatePath)) {
    return {
      status: "unavailable",
      rootCertificatePath,
      trustCommand,
      detail: "Caddy has not generated its local CA root yet. Start `scout server edge` once to create it.",
    };
  }

  if (platform !== "darwin") {
    return {
      status: "skipped",
      rootCertificatePath,
      trustCommand: "caddy trust",
      detail: "Automatic local HTTPS trust is only implemented for macOS right now.",
    };
  }

  const verifyResult = runCommand("security", ["verify-cert", "-c", rootCertificatePath, "-p", "ssl"], {
    encoding: "utf8",
    timeout: 10_000,
    env,
  });
  if (verifyResult.status === 0) {
    return {
      status: "trusted",
      rootCertificatePath,
      trustCommand: null,
      detail: "Caddy's local CA root is trusted by the macOS system keychain.",
    };
  }

  return {
    status: "untrusted",
    rootCertificatePath,
    trustCommand,
    detail: "Caddy's local CA root exists, but macOS does not trust it yet.",
  };
}

function trustOutcome(
  current: ScoutLocalEdgeTrustReport,
  trustResult: ScoutLocalEdgeTrustCommandResult,
  inspectAgain: () => ScoutLocalEdgeTrustReport,
): ScoutLocalEdgeTrustReport {
  if (trustResult.status !== 0) {
    const detail = firstNonEmptyLine(trustResult.stderr)
      ?? firstNonEmptyLine(trustResult.stdout)
      ?? trustResult.error?.message
      ?? "macOS did not trust the Caddy local CA root.";
    return { ...current, status: "error", detail };
  }

  const afterTrust = inspectAgain();
  if (afterTrust.status === "trusted") {
    return {
      ...afterTrust,
      status: "installed",
      detail: "Trusted Caddy's local CA root in the macOS system keychain.",
    };
  }
  return {
    ...afterTrust,
    status: "error",
    detail: "macOS accepted the trust request, but the Caddy local CA root still does not verify as trusted.",
  };
}

/** Trust the local CA root, asking for an administrator password with the
 * standard macOS dialog. Blocks until the dialog is answered; the CLI uses it. */
export function ensureScoutLocalEdgeTrust(options: ScoutLocalEdgeTrustOptions = {}): ScoutLocalEdgeTrustReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const current = inspectScoutLocalEdgeTrust({ env, platform, runCommand });
  if (current.status !== "untrusted" || platform !== "darwin") {
    return current;
  }

  const trustResult = runCommand("osascript", ["-e", renderMacosTrustScript(current.rootCertificatePath)], {
    encoding: "utf8",
    timeout: TRUST_PROMPT_TIMEOUT_MS,
    env,
  });
  return trustOutcome(current, trustResult, () => inspectScoutLocalEdgeTrust({ env, platform, runCommand }));
}

function runOsascriptAsync(script: string, env: NodeJS.ProcessEnv): Promise<ScoutLocalEdgeTrustCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), TRUST_PROMPT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Same as ensureScoutLocalEdgeTrust, but waits for the password dialog
 * without blocking the caller's event loop (the web server uses this). */
export async function ensureScoutLocalEdgeTrustAsync(
  options: Omit<ScoutLocalEdgeTrustOptions, "runCommand"> & {
    runTrustScript?: (script: string, env: NodeJS.ProcessEnv) => Promise<ScoutLocalEdgeTrustCommandResult>;
    runCommand?: ScoutLocalEdgeTrustRunCommand;
  } = {},
): Promise<ScoutLocalEdgeTrustReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const current = inspectScoutLocalEdgeTrust({ env, platform, runCommand });
  if (current.status !== "untrusted" || platform !== "darwin") {
    return current;
  }

  const trustResult = await (options.runTrustScript ?? runOsascriptAsync)(
    renderMacosTrustScript(current.rootCertificatePath),
    env,
  );
  return trustOutcome(current, trustResult, () => inspectScoutLocalEdgeTrust({ env, platform, runCommand }));
}
