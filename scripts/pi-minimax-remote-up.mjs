#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";

const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_DISPLAY_NAME = "Remote Pi MiniMax M3";
const DEFAULT_AGENT_NAME = "remote-pi-minimax";
const PI_PACKAGE = "@oh-my-pi/pi-coding-agent@17.3.4";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

export function validateSshHost(value) {
  const host = String(value ?? "").trim();
  if (!host || !/^[A-Za-z0-9._@%+][A-Za-z0-9._@%+-]*$/.test(host)) {
    throw new Error("--host must be an SSH host or configured alias without shell metacharacters.");
  }
  return host;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    host: "",
    project: "",
    agentName: DEFAULT_AGENT_NAME,
    displayName: DEFAULT_DISPLAY_NAME,
    provider: "minimax",
    model: DEFAULT_MODEL,
    permissionProfile: "workspace_write",
    installPi: false,
    provisionKey: false,
    edgeAuthenticated: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index] ?? "";
    if (current === "--help" || current === "-h") {
      options.help = true;
      continue;
    }
    const valueFlags = {
      "--host": "host",
      "--project": "project",
      "--name": "agentName",
      "--display-name": "displayName",
      "--model": "model",
      "--provider": "provider",
      "--permission-profile": "permissionProfile",
    };
    const key = valueFlags[current];
    if (key) {
      options[key] = requireValue(argv, index, current);
      index += 1;
      continue;
    }
    const inline = Object.entries(valueFlags).find(([flag]) => current.startsWith(`${flag}=`));
    if (inline) {
      options[inline[1]] = current.slice(inline[0].length + 1);
      continue;
    }
    if (current === "--install-pi") {
      options.installPi = true;
      continue;
    }
    if (current === "--provision-key") {
      options.provisionKey = true;
      continue;
    }
    if (current === "--edge-authenticated") {
      options.edgeAuthenticated = true;
      continue;
    }
    if (current === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${current}`);
  }

  if (!options.help) {
    options.host = validateSshHost(options.host);
    if (!options.project.trim()) {
      throw new Error("--project is required and must be the absolute project path on the remote machine.");
    }
    if (!options.project.startsWith("/")) {
      throw new Error("--project must be an absolute remote path.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.agentName)) {
      throw new Error("--name must be a simple Scout agent name.");
    }
    if (options.edgeAuthenticated && options.provisionKey) {
      throw new Error("--edge-authenticated and --provision-key are mutually exclusive.");
    }
  }
  return options;
}

export function remoteLoginCommand(argv) {
  return `sh -lc ${shellQuote(argv.map(shellQuote).join(" "))}`;
}

export function remoteShellCommand(script) {
  return `sh -lc ${shellQuote(script)}`;
}

function runProcess(command, args, { input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.code}`));
      } else {
        resolve(result);
      }
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function ssh(host, argv, options) {
  return runProcess("ssh", [host, remoteLoginCommand(argv)], options);
}

async function sshShell(host, script, options) {
  return runProcess("ssh", [host, remoteShellCommand(script)], options);
}

function readMiniMaxKey() {
  const fromEnv = process.env.MINIMAX_API_KEY || process.env.MINIMAX_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const value = execFileSync("secret", ["get", "MINIMAX_API_KEY"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function remoteHas(host, argv) {
  const result = await ssh(host, argv, { allowFailure: true });
  return result.code === 0;
}

export function remoteSecretPresenceScript() {
  return "secret get MINIMAX_API_KEY >/dev/null 2>&1";
}

export function remoteLinuxCredentialPresenceScript() {
  return 'test -s "$HOME/.config/openscout/credentials/MINIMAX_API_KEY"';
}

export function remoteLinuxCredentialProvisionScript() {
  return [
    "set -eu",
    'credential_dir="$HOME/.config/openscout/credentials"',
    "umask 077",
    'mkdir -p "$credential_dir"',
    'chmod 700 "$credential_dir"',
    'dd of="$credential_dir/MINIMAX_API_KEY" status=none',
    'chmod 600 "$credential_dir/MINIMAX_API_KEY"',
  ].join("; ");
}

async function remoteSecretPresent(host, platform) {
  const script = platform === "Linux"
    ? remoteLinuxCredentialPresenceScript()
    : remoteSecretPresenceScript();
  const result = await sshShell(host, script, { allowFailure: true });
  return result.code === 0;
}

async function installPi(host) {
  await ssh(host, ["bun", "add", "-g", PI_PACKAGE]);
  const omp = await ssh(host, ["command", "-v", "omp"]);
  const binDirectory = await ssh(host, ["bun", "pm", "bin", "-g"]);
  const piPath = `${binDirectory.stdout.trim()}/pi`;
  const existing = await ssh(host, ["test", "-e", piPath], { allowFailure: true });
  if (existing.code !== 0) {
    await ssh(host, ["ln", "-s", omp.stdout.trim(), piPath]);
  }
}

async function provisionKey(host, platform) {
  const key = readMiniMaxKey();
  if (!key) {
    throw new Error("No local MiniMax credential is available in the environment or macOS Keychain.");
  }
  if (platform === "Linux") {
    await sshShell(host, remoteLinuxCredentialProvisionScript(), { input: key });
    return;
  }
  await ssh(host, ["secret", "set", "MINIMAX_API_KEY"], { input: key });
}

function printUsage() {
  console.log(`Register a remote, broker-managed Pi worker that uses MiniMax BYOK.

Usage:
  bun scripts/pi-minimax-remote-up.mjs --host <ssh-alias> --project <remote-path> [options]

Options:
  --name <name>                 Scout handle (default: ${DEFAULT_AGENT_NAME})
  --display-name <name>         UI label (default: ${DEFAULT_DISPLAY_NAME})
  --model <model>               MiniMax model (default: ${DEFAULT_MODEL})
  --provider <provider>         Existing remote Pi provider id (default: minimax)
  --permission-profile <name>   Scout runtime permission profile (default: workspace_write)
  --install-pi                  Install ${PI_PACKAGE} and a pi executable on the remote
  --provision-key               Stream the key into the remote OS credential store
  --edge-authenticated          Use an already-configured provider whose network edge injects auth
  --dry-run                     Print a secret-free plan without contacting the remote
  --help                        Show this help

SSH is bootstrap only. After this command, dispatch through Scout using the
returned agent selector; the remote broker reads MINIMAX_API_KEY from its local
credential store only when it starts the Pi provider process. With
--edge-authenticated, no key is read or transferred; the named Pi provider must
already exist on the remote worker.`);
}

export async function bootstrapRemoteMiniMax(options) {
  const plan = {
    host: options.host,
    project: options.project,
    agentName: options.agentName,
    displayName: options.displayName,
    provider: options.provider,
    model: options.model,
    permissionProfile: options.permissionProfile,
    installPi: options.installPi,
    provisionKey: options.provisionKey,
    edgeAuthenticated: options.edgeAuthenticated,
  };
  if (options.dryRun) {
    return { dryRun: true, plan };
  }

  if (!await remoteHas(options.host, ["test", "-d", options.project])) {
    throw new Error(`Remote project directory does not exist: ${options.project}`);
  }
  if (!await remoteHas(options.host, ["command", "-v", "scout"])) {
    throw new Error("Remote Scout CLI is unavailable. Install/setup Scout on the remote node first.");
  }
  const platformResult = await ssh(options.host, ["uname", "-s"]);
  const platform = platformResult.stdout.trim();
  if (platform !== "Linux" && platform !== "Darwin") {
    throw new Error(`Unsupported remote platform: ${platform || "unknown"}`);
  }
  if (!options.edgeAuthenticated && platform === "Darwin" && !await remoteHas(options.host, ["command", "-v", "secret"])) {
    throw new Error("Remote secret helper is unavailable; refusing to provision or launch a BYOK worker.");
  }

  let piInstalled = await remoteHas(options.host, ["command", "-v", "pi"]);
  if (!piInstalled && options.installPi) {
    await installPi(options.host);
    piInstalled = await remoteHas(options.host, ["command", "-v", "pi"]);
  }
  if (!piInstalled) {
    throw new Error("Remote Pi executable is missing. Rerun with --install-pi after reviewing the pinned package version.");
  }

  if (!options.edgeAuthenticated) {
    let keyPresent = await remoteSecretPresent(options.host, platform);
    if (!keyPresent && options.provisionKey) {
      await provisionKey(options.host, platform);
      keyPresent = await remoteSecretPresent(options.host, platform);
    }
    if (!keyPresent) {
      throw new Error("Remote MiniMax credential is missing. Provision it locally on the worker or rerun with --provision-key.");
    }
  }

  const cardResult = await ssh(options.host, [
    "scout",
    "--json",
    "card",
    "create",
    options.project,
    "--name",
    options.agentName,
    "--display-name",
    options.displayName,
    "--harness",
    "pi",
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--permission-profile",
    options.permissionProfile,
    "--no-input",
  ]);
  let card;
  try {
    card = JSON.parse(cardResult.stdout);
  } catch {
    throw new Error(`Remote Scout returned an invalid card receipt: ${cardResult.stdout.trim()}`);
  }
  return {
    dryRun: false,
    plan: { ...plan, platform },
    card,
    dispatch: `scout ask --to ${card.selector || options.agentName} \"<task>\"`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const result = await bootstrapRemoteMiniMax(options);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
