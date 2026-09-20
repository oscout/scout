/**
 * `scout update` — update this machine, or report on named ones.
 *
 * With no machine names this is exactly `scout install`, delegated verbatim so
 * the long-standing alias keeps its behaviour. With names it resolves them
 * against the machine inventory, reads each machine's app/CLI/runtime versions,
 * and reports what an update would do.
 *
 * It executes only where it can verify the result, which today means the local
 * machine. See `REMOTE_EXECUTION_GAP` in ../machine-update.ts.
 */

import {
  buildSshArgv,
  defaultSshExec,
  parseSshEnrollTarget,
  type SshExec,
} from "@openscout/runtime";
import { machineLabel, type MachineRecord } from "@openscout/protocol";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createScoutCommandContext, type ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  listUnmanagedScoutProcesses,
  emptyReading,
  planMachineUpdate,
  readOwnedSuitePids,
  readSuiteStatus,
  summarizeBridgeClients,
  readRuntimeIdentityFromDoctorStream,
  resolveMachineReferences,
  scoutNodeIdsFor,
  summarizeMachineUpdateRun,
  REMOTE_EXECUTION_GAP,
  UNVERIFIED_COMPONENTS,
  VERIFIED_COMPONENTS,
  type MachineUpdatePlan,
  type MachineUpdateReading,
} from "../machine-update.ts";
import { loadMachines } from "../../core/machines/service.ts";
import { runRemoteCandidateInstall } from "../machine-update-remote.ts";
import { runInstallCommand } from "./install.ts";
import { LAUNCH_AGENT_LABEL as MESH_BRIDGE_LAUNCH_AGENT_LABEL } from "./mesh-bridge.ts";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const PROBE_TIMEOUT_MS = 20_000;

export type ScoutUpdateDependencies = {
  loadMachines?: () => Promise<{ machines: MachineRecord[] }>;
  install?: typeof runInstallCommand;
  /** Reads one machine. Injected in tests so they never reach a network. */
  probe?: (machine: MachineRecord) => Promise<MachineUpdateReading>;
  /** Coordinator-owned remote installer; injected so tests never reach a host. */
  remoteInstall?: typeof runRemoteCandidateInstall;
  exec?: SshExec;
};

type ScoutUpdateOptions = {
  names: string[];
  check: boolean;
  json: boolean;
  version: string | null;
  sshUser: string | null;
  candidate: string | null;
  dmg: string | null;
};

function renderUpdateCommandHelp(): string {
  return [
    "Usage: scout update [machine…] [options]",
    "",
    "With no machine name this updates the local install — the same as `scout install`.",
    "With machine names it reports app, CLI, and runtime versions per machine.",
    "",
    "Options:",
    "  --check            Report only; never install.",
    "  --version <ver>    Target a published release instead of the latest.",
    "  --json             Emit the machine report as JSON.",
    "  --ssh-user <user>  Username for machines your ssh config does not already name.",
    "  --candidate <dir> --dmg <file>",
    "                     Install a signed local build instead of a published release.",
    "                     Install locally or transfer to named Macs through verified SSH.",
    "",
    "Examples:",
    "  scout update",
    "  scout update --check",
    "  scout update Air Mini",
    '  scout update "Art\'s Mini" --check',
    "",
    "Names are matched exactly against machine names, display names, and hostnames.",
    "Each argument is one machine: `scout update Air Mini` is two, `scout update \"Air Mini\"` is one.",
  ].join("\n");
}

function parseUpdateArgs(args: string[]): ScoutUpdateOptions {
  const options: ScoutUpdateOptions = {
    names: [], check: false, json: false, version: null, sshUser: null,
    candidate: null, dmg: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--version") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new ScoutCliError("--version needs a release version, e.g. --version 0.2.101");
      }
      options.version = value;
      index += 1;
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--ssh-user") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new ScoutCliError("--ssh-user needs a username, e.g. --ssh-user arach");
      }
      options.sshUser = value;
      index += 1;
    } else if (arg.startsWith("--ssh-user=")) {
      options.sshUser = arg.slice("--ssh-user=".length);
    } else if (arg === "--candidate" || arg === "--dmg") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new ScoutCliError(`${arg} needs a path.`);
      }
      if (arg === "--candidate") options.candidate = value;
      else options.dmg = value;
      index += 1;
    } else if (arg.startsWith("--candidate=")) {
      options.candidate = arg.slice("--candidate=".length);
    } else if (arg.startsWith("--dmg=")) {
      options.dmg = arg.slice("--dmg=".length);
    } else if (arg.startsWith("-")) {
      // Unknown flags belong to `scout install`; only the local path takes them.
      options.names.push(arg);
    } else {
      options.names.push(arg);
    }
  }
  return options;
}

/**
 * The artifact-selection flags to hand the installer.
 *
 * A candidate is only ever used when the operator named one explicitly. The
 * default stays the published release, so a fleet command never reaches for a
 * private build implicitly.
 */
function artifactArgs(options: ScoutUpdateOptions): string[] {
  if (options.candidate && options.dmg) {
    return ["--candidate", options.candidate, "--dmg", options.dmg];
  }
  return options.version ? ["--version", options.version] : [];
}

/**
 * Ask the installer what the target is, rather than resolving releases a second
 * way. `--check` is read-only and already knows how to pick the artifact — a
 * published release, or the signed local candidate when one is named.
 */
async function resolvePublishedTarget(
  context: ScoutCommandContext,
  options: ScoutUpdateOptions,
  install: typeof runInstallCommand,
): Promise<{ target: string | null; installed: string | null }> {
  const captured: string[] = [];
  const probeContext = createScoutCommandContext({
    cwd: context.cwd,
    env: context.env,
    stdout: (line) => captured.push(line),
    // The installer's own progress notes are not this command's output.
    stderr: () => {},
    outputMode: "json",
    isTty: false,
  });

  await install(probeContext, ["--check", ...artifactArgs(options)]);

  try {
    const payload = JSON.parse(captured.join("\n")) as { target?: unknown; installed?: unknown };
    return {
      target: typeof payload.target === "string" ? payload.target : null,
      installed: typeof payload.installed === "string" ? payload.installed : null,
    };
  } catch {
    throw new ScoutCliError("could not read the published release version from `scout install --check`.");
  }
}

/** An IPv4 literal or anything containing a colon (IPv6). */
function isAddressLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * Literal `Host` aliases from the operator's ssh config.
 *
 * An alias carries the parts an inventory address cannot: the username, the
 * identity file, a jump host. Reaching a machine by its tailnet address
 * silently discards all of that and logs in as the wrong user, so an alias the
 * operator already wrote always wins over an address we derived.
 *
 * Wildcard patterns are skipped — `Host *` matches everything and names nothing.
 */
export function readSshConfigAliases(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Set<string> {
  const aliases = new Set<string>();
  let contents: string;
  try {
    contents = read(join(homedir(), ".ssh", "config"));
  } catch {
    return aliases;
  }
  for (const line of contents.split("\n")) {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const token of match[1]!.trim().split(/\s+/)) {
      if (token.startsWith("#")) break;
      if (token.includes("*") || token.includes("?") || token.includes("!")) continue;
      aliases.add(token.toLowerCase());
    }
  }
  return aliases;
}

/**
 * Pick the one destination to reach a machine by.
 *
 * An ssh config alias wins outright. Otherwise the choice is strictly tiered —
 * a tailnet name beats a LAN name beats a discovered hostname — and within a
 * tier a DNS name wins over a raw address, because a machine normally publishes
 * an IPv4, an IPv6, and a name for the *same* identity. Two distinct names in
 * the winning tier are two identities, and there the command refuses: it may
 * not guess which machine it is about to read or restart.
 */
export function resolveMachineSshDestination(
  machine: MachineRecord,
  options: { sshUser?: string | null; aliases?: Set<string> } = {},
): string {
  const label = machineLabel(machine);
  const aliases = options.aliases ?? new Set<string>();
  const names = [machine.displayName ?? "", machine.name, ...machine.hostNames]
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of names) {
    // Return the alias verbatim: ssh applies its User, IdentityFile, and
    // HostName itself, which is the whole point of using it.
    if (aliases.has(name.toLowerCase())) return name;
  }

  // The `ssh` capability is only ever observed from a Bonjour `_ssh._tcp`
  // advert, and this Mac only hears those on its own LAN — a Mac reached over
  // the tailnet never carries it however reachable it is, so the gate alone
  // would put every off-LAN machine permanently out of the command's reach.
  // A Host entry is the operator's own statement that the machine takes ssh,
  // which is why it is read first; the advert stays the only evidence for a
  // machine nothing in the ssh config names.
  if (!machine.capabilities.includes("ssh")) {
    throw new ScoutCliError(`${label} does not advertise ssh — cannot read its versions.`);
  }

  const tiers: string[][] = [
    machine.routes.filter((route) => route.kind === "tailnet").map((route) => route.host),
    machine.routes.filter((route) => route.kind === "lan").map((route) => route.host),
    [...machine.hostNames],
  ];

  for (const tier of tiers) {
    const hosts = [...new Set(tier.map((host) => host.trim()).filter((host) => host.length > 0))];
    if (hosts.length === 0) continue;
    const named = hosts.filter((host) => !isAddressLiteral(host));
    const candidates = named.length > 0 ? named : hosts;
    if (candidates.length > 1) {
      throw new ScoutCliError(
        `${label} has more than one identity at the same tier (${candidates.join(", ")}) — `
        + "cannot pick an unambiguous one.",
      );
    }
    const host = candidates[0]!;
    return options.sshUser ? `${options.sshUser}@${host}` : host;
  }
  throw new ScoutCliError(
    `${label} has no reachable hostname — cannot read its versions. `
    + "Add a Host entry for it in your ssh config, or pass --ssh-user.",
  );
}

function readJsonStdout(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Read one machine's versions.
 *
 * Every command here is read-only. `scout install --check` reports the app
 * version, `scout doctor scoutd --json` the runtime, and `scout --version` the
 * CLI — which the app version does not imply, because the CLI is a separate
 * package that can lag behind its own app.
 */
function createDefaultProbe(exec: SshExec, options: { sshUser: string | null }) {
  const aliases = readSshConfigAliases();
  return async function probe(machine: MachineRecord): Promise<MachineUpdateReading> {
    // Local and remote differ only in argv: the same never-a-shell runner spawns
    // `scout …` here or `ssh host scout …` there.
    const wrap = machine.isSelf
      ? (command: string[]) => command
      : (() => {
          const destination = resolveMachineSshDestination(machine, {
            sshUser: options.sshUser,
            aliases,
          });
          const target = parseSshEnrollTarget(`ssh://${destination}`);
          return (command: string[]) => buildSshArgv(target, command);
        })();

    async function read(command: string[]): Promise<{ stdout: string; failure: string | null }> {
      try {
        const result = await exec({ argv: wrap(command), timeoutMs: PROBE_TIMEOUT_MS });
        if (result.exitCode !== 0) {
          return { stdout: "", failure: result.stderr.trim() || `exit ${result.exitCode}` };
        }
        return { stdout: result.stdout, failure: null };
      } catch (error) {
        return { stdout: "", failure: error instanceof Error ? error.message : String(error) };
      }
    }

    const app = await read(["scout", "install", "--check", "--json"]);
    if (app.failure) return emptyReading(app.failure);
    const appPayload = readJsonStdout(app.stdout) as { installed?: unknown } | null;

    // `scout doctor --json` is the only surface that carries scoutd's runtime
    // verdict; `scout app status --json` reports the app process tree and has
    // no runtimeFreshness at all.
    const runtime = await read(["scout", "doctor", "--json"]);
    const identity = readRuntimeIdentityFromDoctorStream(runtime.stdout);

    const cli = await read(["scout", "--version"]);

    // Bridges: Scout processes the managed suite does not own. `scout app
    // status --json` names the suite's pids; anything else matching a Scout
    // command path is a harness-held MCP or channel bridge still running the
    // code it started with.
    const suite = await read(["scout", "app", "status", "--json"]);
    // `ppid` names the harness holding a bridge open and `etime` says how long
    // it has been running its original code — both are what an operator needs
    // to go reconnect one, and neither is recoverable from a count.
    const processes = suite.failure
      ? { stdout: "", failure: suite.failure }
      : await read(["ps", "-axo", "pid=,ppid=,etime=,args="]);
    const suitePayload = suite.failure ? null : readJsonStdout(suite.stdout);
    const unmanaged = suite.failure || processes.failure
      ? null
      : listUnmanagedScoutProcesses(processes.stdout, readOwnedSuitePids(suitePayload));

    return {
      appVersion: typeof appPayload?.installed === "string" ? appPayload.installed : null,
      cliVersion: cli.failure ? null : cli.stdout.trim() || null,
      runtimeVersion: identity.runtimeVersion,
      runtimeIntentional: identity.runtimeIntentional,
      runtimeState: identity.runtimeState,
      runtimeCommit: identity.runtimeCommit,
      unmanagedScoutProcesses: unmanaged,
      suite: suitePayload === null ? null : readSuiteStatus(suitePayload),
      // A runtime we could not read is not a reason to block the app report,
      // but an unreadable app version is — that is the version we compare.
      probeError: null,
    };
  };
}

/** `["a", "b", "c"]` → `"a, b, and c"`. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * What is still outstanding on a machine that did not land on the target.
 *
 * Every machine that is not `up-to-date` gets one of these, on a check as much
 * as after an install: reporting that there is work and then printing an empty
 * next-steps list tells the operator half of the answer.
 *
 * The state decides the wording before the components do. A held machine reads
 * as `behind` on its app and `ahead` on its runtime at the same time, and
 * telling it to install would be advice against the operator's own decision.
 */
function nextStepFor(plan: MachineUpdatePlan): string {
  // Suite problems are outstanding work no matter which state won the plan. A
  // held machine with a foreign-owned service still has a service to settle,
  // and the hold is not a reason to stop reporting it.
  const suite = plan.reading.suite;
  const suffix = plan.state !== "suite-problems" && suite && suite.issues.length > 0
    ? ` Separately, the managed suite reports: ${suite.issues.join("; ")}.`
    : "";
  return `${nextStepBody(plan)}${suffix}`;
}

function nextStepBody(plan: MachineUpdatePlan): string {
  if (plan.state === "source-owned") {
    return `${plan.label}: runtime is source-owned (${plan.reading.runtimeState ?? "pinned"}) and held — `
      + "moving it onto a published artifact is an explicit ownership transition, and this command "
      + "will not make it.";
  }
  if (plan.state === "offline" || plan.state === "unreadable" || plan.state === "downgrade-blocked") {
    // The plan already says exactly what is wrong, in the machine's own terms.
    return `${plan.label}: ${plan.reason}`;
  }
  const behind = plan.components
    .filter((component) => component.status === "behind")
    .map((component) => component.name);
  if (behind.length > 0) {
    const where = plan.isSelf ? "here" : `on ${plan.label}`;
    return `${plan.label}: ${joinNames(behind)} still behind — install the matching `
      + `@openscout/scout package ${where}; the native installer does not move `
      + `${joinNames(behind)}.`;
  }
  if (plan.state === "bridges-pending") {
    const bridges = plan.reading.unmanagedScoutProcesses ?? [];
    // The suite's own launchd bridge and a harness-held one need different
    // actions, and there is no session to restart for the first.
    const launchd = bridges.filter((bridge) => bridge.bridge === "mesh" && bridge.ppid === 1);
    const harness = bridges.filter((bridge) => !launchd.includes(bridge));
    const steps: string[] = [];
    if (harness.length > 0) {
      steps.push(`${harness.length} held by a harness session (${summarizeBridgeClients(harness)}). `
        + "Reconnect their Scout connections in the owning harness session when it is safe to pause; "
        + "installing again will not replace a process that is already running");
    }
    if (launchd.length > 0) {
      const label = MESH_BRIDGE_LAUNCH_AGENT_LABEL;
      const pids = launchd.map((bridge) => bridge.pid);
      steps.push(`${pids.length} with ppid 1 (launchd or orphan; pid ${pids.join(", ")}); job ownership `
        + `is unverified. Check \`launchctl list ${label}\` there and compare its PID. Only if it `
        + `matches this suite mesh bridge, run \`launchctl kickstart -k `
        + `gui/$(id -u)/${label}\` or re-run \`scout mesh bridge install\`; otherwise identify its owner first`);
    }
    return `${plan.label}: ${bridges.length} Scout bridge${bridges.length === 1 ? "" : "s"} outside the `
      + `managed suite have unverified release identities. ${steps.join(". ")}.`;
  }
  if (plan.state === "suite-problems") {
    const issues = plan.reading.suite?.issues ?? [];
    return `${plan.label}: the managed suite reports ${issues.length} problem`
      + `${issues.length === 1 ? "" : "s"} — ${issues.join("; ")}. Run \`scout app restart\` there, and `
      + "for a foreign-owned service settle which build owns it before installing again.";
  }
  if (plan.state === "convergence-unverified") {
    // Bridges are also null when `ps` fails with the suite readable, so name both.
    return `${plan.label}: ${plan.reason} Re-run once \`scout app status --json\` and `
      + "`ps -axo pid=,ppid=,etime=,args=` both answer there.";
  }
  return `${plan.label}: ${plan.reason}`;
}

/** How many bridges the text report names before deferring to `--json`. */
const BRIDGE_LIST_LIMIT = 8;

function renderPlan(plan: MachineUpdatePlan): string {
  // Each component carries its own verdict, so a stale CLI is visible next to a
  // current app instead of being averaged away into one machine-level word.
  const versions = plan.components
    .map((component) => `${component.name} ${component.version ?? "unreadable"} (${component.status})`)
    .join(", ");
  const bridges = plan.reading.unmanagedScoutProcesses;
  const suite = plan.reading.suite;
  const lines = [`${plan.label} — ${plan.state}`, `    ${versions}`];
  if (suite === null) {
    lines.push("    managed suite: not read");
  } else if (suite.issues.length === 0) {
    lines.push("    managed suite: running, all services owned by the installed bundle");
  } else {
    lines.push(`    managed suite: ${suite.issues.length} problem${suite.issues.length === 1 ? "" : "s"}`);
    for (const issue of suite.issues) lines.push(`      ${issue}`);
  }
  if (bridges === null) {
    lines.push("    bridges outside the managed suite: not read");
  } else if (bridges.length === 0) {
    lines.push("    bridges outside the managed suite: none");
  } else {
    lines.push(`    bridges outside the managed suite: ${bridges.length} (${summarizeBridgeClients(bridges)})`);
    // Cap the listing: a machine can hold dozens, and the JSON payload carries
    // every one of them for anyone who needs the full set.
    for (const bridge of bridges.slice(0, BRIDGE_LIST_LIMIT)) {
      lines.push(
        `      pid ${bridge.pid} ppid ${bridge.ppid ?? "?"} up ${bridge.elapsed ?? "?"} `
        + `${bridge.bridge} — ${bridge.launchdLabel ?? bridge.client ?? "unknown client"}`,
      );
    }
    if (bridges.length > BRIDGE_LIST_LIMIT) {
      lines.push(`      … ${bridges.length - BRIDGE_LIST_LIMIT} more (full list in --json)`);
    }
  }
  lines.push(`    ${plan.reason}`);
  return lines.join("\n");
}

export async function runUpdateCommand(
  context: ScoutCommandContext,
  args: string[],
  dependencies: ScoutUpdateDependencies = {},
): Promise<void> {
  if (HELP_FLAGS.has(args[0] ?? "")) {
    context.output.writeText(renderUpdateCommandHelp());
    return;
  }

  const install = dependencies.install ?? runInstallCommand;
  const options = parseUpdateArgs(args);
  const names = options.names.filter((name) => !name.startsWith("-"));

  // No machine named: this is the local install, unchanged. Hand every argument
  // through untouched so the alias keeps its exact behaviour and its flags.
  if (names.length === 0) {
    await install(context, args);
    return;
  }

  // --force defeats the downgrade and convergence checks that are the reason
  // this command exists, so it stays a per-machine `scout install` decision.
  if (options.names.includes("--force") || args.some((arg) => arg === "--force")) {
    throw new ScoutCliError(
      "--force is not available for a named machine update — it bypasses the downgrade and "
      + "convergence checks. Run `scout install --force` on that machine directly.",
    );
  }
  // A candidate is served only when named in full, and only to this machine:
  // an unpublished build has no published artifact for a remote box to fetch.
  if (Boolean(options.candidate) !== Boolean(options.dmg)) {
    throw new ScoutCliError("--candidate and --dmg must be given together.");
  }

  const loadInventory = dependencies.loadMachines ?? (() => loadMachines());
  const inventory = await loadInventory();
  const resolutions = resolveMachineReferences(names, inventory.machines);

  // Fail closed before anything is read or dispatched: a run that touches two
  // of three named machines and then stops is worse than one that never starts.
  const unresolved = resolutions.filter((entry) => entry.kind !== "resolved");
  if (unresolved.length > 0) {
    const lines = unresolved.map((entry) =>
      entry.kind === "ambiguous"
        ? `  ${entry.reference} matches more than one machine: ${entry.candidates.join(", ")}`
        : `  ${entry.reference} is not a known machine`,
    );
    const known = inventory.machines.map((machine) => machineLabel(machine)).sort();
    throw new ScoutCliError(
      [`could not resolve every machine:`, ...lines, "", `Known machines: ${known.join(", ") || "none"}`]
        .join("\n"),
    );
  }

  const machines = resolutions.flatMap((entry) => (entry.kind === "resolved" ? [entry.machine] : []));

  const { target } = await resolvePublishedTarget(context, options, install);
  if (!target) {
    // Without a target there is nothing to compare against, and reporting every
    // machine as unreadable would blame the fleet for a lookup that failed here.
    throw new ScoutCliError(
      "could not determine the published release to update to. A named update installs a "
      + "published artifact only, so a release that is not on the feed yet cannot be targeted "
      + "here — install it per machine with `scout install --candidate <dir> --dmg <file>`.",
    );
  }
  const probe = dependencies.probe
    ?? createDefaultProbe(dependencies.exec ?? defaultSshExec, { sshUser: options.sshUser });

  async function planFor(machine: MachineRecord): Promise<MachineUpdatePlan> {
    let reading: MachineUpdateReading;
    try {
      reading = await probe(machine);
    } catch (error) {
      reading = emptyReading(error instanceof Error ? error.message : String(error));
    }
    return planMachineUpdate({
      machine,
      reading,
      targetVersion: target,
      remoteCandidate: Boolean(options.candidate && options.dmg),
    });
  }

  const plans: MachineUpdatePlan[] = [];
  for (const machine of machines) {
    plans.push(await planFor(machine));
  }

  // Install only where the result can be re-read, and only when asked to.
  const performed: string[] = [];
  const nextSteps: string[] = [];
  const remoteInstall = dependencies.remoteInstall ?? runRemoteCandidateInstall;

  if (!options.check) {
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index]!;
      const machine = machines[index]!;

      if (plan.execution === "local-install") {
        await install(context, artifactArgs(options));
      } else if (plan.execution === "remote-candidate-install") {
        // The helper verifies the node identity and an idle broker before it
        // installs, and returns a receipt. A throw here is a real failure: the
        // machine is left reported, never assumed updated.
        const destination = resolveMachineSshDestination(machine, {
          sshUser: options.sshUser,
          aliases: readSshConfigAliases(),
        });
        context.stderr(`Installing the signed candidate on ${plan.label} (${destination})…`);
        await remoteInstall({
          target: parseSshEnrollTarget(`ssh://${destination}`),
          expectedNodeIds: scoutNodeIdsFor(machine),
          candidate: options.candidate!,
          dmg: options.dmg!,
          exec: dependencies.exec,
        });
      } else {
        continue;
      }

      performed.push(plan.label);
      // Installing is not converging. The local installer replaces the app, and
      // the remote helper installs the native app and nothing else; the CLI and
      // runtime are separate packages. Read the machine again and report what it
      // actually runs now.
      plans[index] = await planFor(machine);
    }
  }

  // Every machine that did not land on the target owes a next step, whether or
  // not this run installed anything. A `--check` that reports bridges pending
  // and then an empty `nextSteps` has told the operator there is work and
  // withheld what to do about it.
  for (const plan of plans) {
    if (plan.state === "up-to-date") continue;
    nextSteps.push(nextStepFor(plan));
  }

  const summary = summarizeMachineUpdateRun(plans, { check: options.check, installed: performed });
  const report = {
    action: "update" as const,
    status: summary.status,
    check: options.check,
    target,
    // Says plainly that the target was a local signed build, not a release.
    artifact: options.candidate ? ("candidate" as const) : ("published" as const),
    summary: summary.summary,
    performed,
    nextSteps,
    // Named so a reader never has to infer why a remote machine only got a plan.
    gap: plans.some((plan) => plan.execution === "planner-only") ? REMOTE_EXECUTION_GAP : null,
    // Carried in the payload so a scripted reader sees the scope of the claim,
    // not just the status word.
    verified: [...VERIFIED_COMPONENTS],
    unverified: [...UNVERIFIED_COMPONENTS],
    machines: plans,
  };

  const output = options.json
    ? createScoutCommandContext({
        cwd: context.cwd,
        env: context.env,
        stdout: (line) => context.stdout(line),
        stderr: (line) => context.stderr(line),
        outputMode: "json",
        isTty: false,
      }).output
    : context.output;

  output.writeValue(report, (value) => {
    const lines = [`Target: ${value.target ?? "unknown"} (${value.artifact})`, ""];
    lines.push(...value.machines.map(renderPlan));
    lines.push("", `${value.status}: ${value.summary}`);
    // Say what was not looked at, every run. A machine can carry all three
    // components on the target while its bridges are still old processes.
    lines.push(
      `Compared ${value.verified.join(", ")}. A bridge's own release identity is not readable, so an `
      + "empty inventory is not proof of convergence.",
    );
    if (value.performed.length > 0) {
      // "Ran the installer" is the honest claim; whether the machine converged
      // is the status line above, read back after the install.
      lines.push(`Ran the installer on: ${value.performed.join(", ")}`);
    }
    if (value.nextSteps.length > 0) {
      lines.push("", "Still outstanding:");
      lines.push(...value.nextSteps.map((step) => `  - ${step}`));
    }
    if (value.gap) {
      // Say plainly that nothing was done remotely, so this is never read as a
      // completed fleet update.
      lines.push("", `Not performed remotely. ${value.gap}`);
    }
    return lines.join("\n");
  });

  if (summary.exitCode !== 0) {
    process.exitCode = summary.exitCode;
  }
}
