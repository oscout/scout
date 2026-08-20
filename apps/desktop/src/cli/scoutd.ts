import { spawn } from "node:child_process";

import {
  openScoutNetworkServiceEnvironment,
  resolveBrokerServiceConfig,
  resolveScoutdCommand,
  type BrokerServiceConfig,
} from "@openscout/runtime";

import { extractBuildIdentityFromScoutdPayload } from "./uptodate.ts";
import { SCOUTD_RESTART_TIMEOUT_MS } from "./scoutd-timing.ts";

export type NativeScoutdCommand = "status" | "doctor" | "restart";

export type NativeScoutdProcess = {
  pid: number | null;
  ppid: number | null;
  pcpu: string | null;
  pmem: string | null;
  elapsed: string | null;
  command: string;
};

export type NativeScoutdFixEntry = {
  id: string | null;
  title: string;
  status: string | null;
  detail: string | null;
  changed: boolean | null;
};

export type NativeScoutdDoctorReport = {
  available: boolean;
  scoutdPath: string | null;
  source: string | null;
  error: string | null;
  fixRequested: boolean;
  yes: boolean;
  buildIdentity: string | null;
  status: {
    label: string | null;
    loaded: boolean | null;
    installed: boolean | null;
    pid: number | null;
    launchdState: string | null;
    reachable: boolean | null;
    healthOk: boolean | null;
    healthTransport: string | null;
    healthError: string | null;
    brokerUrl: string | null;
    brokerSocketPath: string | null;
    scoutdStatePath: string | null;
    runtimeFreshness: {
      state: string;
      intentional: boolean | null;
      basis: string | null;
      reasonCode: string | null;
      actualBuiltAt: string | null;
      expectedBuiltAt: string | null;
      detail: string | null;
    } | null;
  } | null;
  warnings: string[];
  probes: {
    socketPath: string | null;
    socketExists: boolean | null;
    reachable: boolean | null;
    daemonVersion: string | null;
    families: Array<{ probeId: string; schemaVersion: number | null; ttlMs: number | null }>;
    error: string | null;
  } | null;
  processes: NativeScoutdProcess[];
  fix: {
    supported: boolean;
    entries: NativeScoutdFixEntry[];
    raw: unknown;
  };
  raw: unknown;
};

export type NativeScoutdJsonOutcome =
  | {
      ok: true;
      command: NativeScoutdCommand;
      scoutdPath: string;
      source: string;
      raw: unknown;
      stdout: string;
    }
  | {
      ok: false;
      command: NativeScoutdCommand;
      reason: "missing" | "failed";
      scoutdPath: string | null;
      source: string | null;
      error: string;
      stdout?: string;
      stderr?: string;
    };

const SCOUTD_JSON_TIMEOUT_MS = 20_000;
const SCOUTD_MAX_BUFFER = 2 * 1024 * 1024;
const SCOUTD_KILL_GRACE_MS = 250;

function buildNativeScoutdEnvironment(
  config: BrokerServiceConfig,
  scoutdPath: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    OPENSCOUT_SCOUTD_BIN: scoutdPath,
    OPENSCOUT_RUNTIME_PACKAGE_DIR: config.runtimePackageDir,
    OPENSCOUT_SUPPORT_DIRECTORY: config.supportDirectory,
    OPENSCOUT_CONTROL_HOME: config.controlHome,
    OPENSCOUT_BROKER_HOST: config.brokerHost,
    OPENSCOUT_BROKER_PORT: String(config.brokerPort),
    OPENSCOUT_BROKER_URL: config.brokerUrl,
    OPENSCOUT_BROKER_SOCKET_PATH: config.brokerSocketPath,
    OPENSCOUT_BROKER_SERVICE_MODE: config.mode,
    OPENSCOUT_BROKER_SERVICE_LABEL: config.label,
    OPENSCOUT_SERVICE_LABEL: config.label,
    OPENSCOUT_ADVERTISE_SCOPE: config.advertiseScope,
    ...openScoutNetworkServiceEnvironment(env),
  };
  if (config.bunExecutable) {
    nextEnv.OPENSCOUT_BUN_BIN = config.bunExecutable;
  }
  if (config.coreAgents.length > 0) {
    nextEnv.OPENSCOUT_CORE_AGENTS = config.coreAgents.join(",");
  }
  return nextEnv;
}

export function nativeScoutdCommandTimeoutMs(command: NativeScoutdCommand, timeoutMs?: number): number {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  return command === "restart" ? SCOUTD_RESTART_TIMEOUT_MS : SCOUTD_JSON_TIMEOUT_MS;
}

export async function runNativeScoutdJson(
  command: NativeScoutdCommand,
  options: {
    flags?: string[];
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    config?: BrokerServiceConfig;
  } = {},
): Promise<NativeScoutdJsonOutcome> {
  const env = options.env ?? process.env;
  let config: BrokerServiceConfig;
  try {
    config = options.config ?? resolveBrokerServiceConfig();
  } catch (error) {
    return {
      ok: false,
      command,
      reason: "failed",
      scoutdPath: null,
      source: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const scoutd = resolveScoutdCommand(config);
  if (!scoutd) {
    return {
      ok: false,
      command,
      reason: "missing",
      scoutdPath: null,
      source: null,
      error: "scoutd not found",
    };
  }

  const args = [command, "--json", ...(options.flags ?? [])];
  const timeoutMs = nativeScoutdCommandTimeoutMs(command, options.timeoutMs);
  const childEnv = buildNativeScoutdEnvironment(config, scoutd.path, env);

  return new Promise((resolvePromise) => {
    const child = spawn(scoutd.path, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (outcome: NativeScoutdJsonOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolvePromise(outcome);
    };

    const terminate = (): void => {
      child.kill("SIGTERM");
      const hardKillTimer = setTimeout(() => child.kill("SIGKILL"), SCOUTD_KILL_GRACE_MS);
      hardKillTimer.unref?.();
    };

    const fail = (error: string): void => {
      finish({
        ok: false,
        command,
        reason: "failed",
        scoutdPath: scoutd.path,
        source: scoutd.source,
        error,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      terminate();
      fail(`scoutd ${command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    killTimer.unref?.();

    const append = (kind: "stdout" | "stderr", chunk: unknown): void => {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      if (kind === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (stdout.length + stderr.length > SCOUTD_MAX_BUFFER) {
        terminate();
        fail(`scoutd ${command} exceeded output limit`);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => fail(`scoutd ${command} failed: ${error.message}`));
    child.on("close", (code, signal) => {
      if (settled || timedOut) return;
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      if ((code ?? 1) !== 0) {
        fail(trimmedStderr || trimmedStdout || `scoutd ${command} exited with ${signal ?? code ?? "unknown status"}`);
        return;
      }

      try {
        finish({
          ok: true,
          command,
          scoutdPath: scoutd.path,
          source: scoutd.source,
          raw: JSON.parse(trimmedStdout) as unknown,
          stdout: trimmedStdout,
        });
      } catch {
        fail(`scoutd ${command} returned non-JSON stdout: ${trimmedStdout.slice(0, 400)}`);
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function diagnosticText(value: unknown): string | null {
  const direct = readString(value);
  if (direct) return direct;
  if (isRecord(value)) {
    const message = readString(value.message)
      ?? readString(value.detail)
      ?? readString(value.title)
      ?? readString(value.id);
    if (message) return message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function readWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(diagnosticText)
    .filter((entry): entry is string => Boolean(entry));
}

function readProcesses(value: unknown): NativeScoutdProcess[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const command = readString(entry.command);
    if (!command) {
      return [];
    }
    return [{
      pid: readNumber(entry.pid),
      ppid: readNumber(entry.ppid),
      pcpu: readString(entry.pcpu),
      pmem: readString(entry.pmem),
      elapsed: readString(entry.elapsed),
      command,
    }];
  });
}

function normalizeFixEntry(value: unknown, fallbackId: string | null = null): NativeScoutdFixEntry | null {
  const direct = readString(value);
  if (direct) {
    return {
      id: fallbackId,
      title: direct,
      status: null,
      detail: null,
      changed: null,
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value.id) ?? fallbackId;
  const title = readString(value.title)
    ?? readString(value.name)
    ?? readString(value.label)
    ?? id
    ?? "repair action";
  const status = readString(value.status) ?? readString(value.outcome) ?? readString(value.result);
  const changed = readBoolean(value.changed) ?? readBoolean(value.applied) ?? readBoolean(value.fixed);

  return {
    id,
    title,
    status: status ?? (changed === true ? "applied" : null),
    detail: readString(value.detail) ?? readString(value.message) ?? readString(value.error),
    changed,
  };
}

function readFixEntries(value: unknown): NativeScoutdFixEntry[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeFixEntry(entry))
      .filter((entry): entry is NativeScoutdFixEntry => Boolean(entry));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .map(([key, entry]) => normalizeFixEntry(entry, key))
    .filter((entry): entry is NativeScoutdFixEntry => Boolean(entry));
}

function readFixReport(raw: unknown): NativeScoutdDoctorReport["fix"] {
  if (!isRecord(raw)) {
    return { supported: false, entries: [], raw: null };
  }

  for (const key of ["fixes", "repairs", "repairActions", "actions"]) {
    if (hasOwn(raw, key)) {
      return {
        supported: true,
        entries: readFixEntries(raw[key]),
        raw: raw[key],
      };
    }
  }

  if (hasOwn(raw, "fix")) {
    const fix = raw.fix;
    if (isRecord(fix)) {
      const entries = readFixEntries(fix.actions)
        .concat(readFixEntries(fix.fixes))
        .concat(readFixEntries(fix.repairs));
      return {
        supported: readBoolean(fix.supported) ?? true,
        entries,
        raw: fix,
      };
    }

    return {
      supported: readBoolean(fix) ?? true,
      entries: [],
      raw: fix,
    };
  }

  return { supported: false, entries: [], raw: null };
}

function readStatus(raw: unknown): NativeScoutdDoctorReport["status"] {
  if (!isRecord(raw)) {
    return null;
  }
  const status = isRecord(raw.status) ? raw.status : raw;
  const health = isRecord(status.health) ? status.health : {};
  const runtimeFreshness = isRecord(status.runtimeFreshness) ? status.runtimeFreshness : null;

  return {
    label: readString(status.label),
    loaded: readBoolean(status.loaded),
    installed: readBoolean(status.installed),
    pid: readNumber(status.pid),
    launchdState: readString(status.launchdState),
    reachable: readBoolean(status.reachable) ?? readBoolean(health.reachable),
    healthOk: readBoolean(health.ok),
    healthTransport: readString(health.transport),
    healthError: readString(health.error),
    brokerUrl: readString(status.brokerUrl),
    brokerSocketPath: readString(status.brokerSocketPath),
    scoutdStatePath: readString(status.scoutdStatePath),
    runtimeFreshness: runtimeFreshness && readString(runtimeFreshness.state)
      ? {
          state: readString(runtimeFreshness.state)!,
          intentional: readBoolean(runtimeFreshness.intentional),
          basis: readString(runtimeFreshness.basis),
          reasonCode: readString(runtimeFreshness.reasonCode),
          actualBuiltAt: readString(runtimeFreshness.actualBuiltAt),
          expectedBuiltAt: readString(runtimeFreshness.expectedBuiltAt),
          detail: readString(runtimeFreshness.detail),
        }
      : null,
  };
}

function readProbeStatus(raw: unknown): NativeScoutdDoctorReport["probes"] {
  if (!isRecord(raw)) {
    return null;
  }
  const status = isRecord(raw.status) ? raw.status : raw;
  const probes = isRecord(status.probes) ? status.probes : isRecord(raw.probes) ? raw.probes : null;
  if (!probes) {
    return null;
  }
  const families = Array.isArray(probes.families)
    ? probes.families.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const probeId = readString(entry.probeId);
        if (!probeId) return [];
        return [{
          probeId,
          schemaVersion: readNumber(entry.schemaVersion),
          ttlMs: readNumber(entry.ttlMs),
        }];
      })
    : [];
  return {
    socketPath: readString(probes.socketPath),
    socketExists: readBoolean(probes.socketExists),
    reachable: readBoolean(probes.reachable),
    daemonVersion: readString(probes.daemonVersion),
    families,
    error: readString(probes.error),
  };
}

export function normalizeNativeScoutdDoctorReport(input: {
  raw: unknown;
  scoutdPath: string | null;
  source: string | null;
  error?: string | null;
  fixRequested?: boolean;
  yes?: boolean;
  available?: boolean;
}): NativeScoutdDoctorReport {
  const raw = input.raw;
  const record = isRecord(raw) ? raw : {};

  return {
    available: input.available ?? true,
    scoutdPath: input.scoutdPath,
    source: input.source,
    error: input.error ?? null,
    fixRequested: input.fixRequested ?? false,
    yes: input.yes ?? false,
    buildIdentity: extractBuildIdentityFromScoutdPayload(raw),
    status: readStatus(raw),
    warnings: readWarnings(record.warnings),
    probes: readProbeStatus(raw),
    processes: readProcesses(record.processes),
    fix: readFixReport(raw),
    raw,
  };
}

export async function loadNativeScoutdDoctorReport(input: {
  fix?: boolean;
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<NativeScoutdDoctorReport> {
  const fix = input.fix ?? false;
  const yes = input.yes ?? false;
  const flags = fix ? ["--fix", ...(yes ? ["--yes"] : [])] : [];
  const outcome = await runNativeScoutdJson("doctor", {
    flags,
    env: input.env,
  });

  if (outcome.ok) {
    return normalizeNativeScoutdDoctorReport({
      raw: outcome.raw,
      scoutdPath: outcome.scoutdPath,
      source: outcome.source,
      fixRequested: fix,
      yes,
    });
  }

  return normalizeNativeScoutdDoctorReport({
    raw: null,
    scoutdPath: outcome.scoutdPath,
    source: outcome.source,
    available: outcome.reason !== "missing",
    error: outcome.error,
    fixRequested: fix,
    yes,
  });
}

function yesNo(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

function compactCommand(command: string): string {
  return command.length <= 150 ? command : `${command.slice(0, 147)}...`;
}

function renderFixLines(report: NativeScoutdDoctorReport): string[] {
  if (!report.fixRequested) {
    return ["  Repair: not requested"];
  }
  if (report.error) {
    return ["  Repair: not run"];
  }
  if (!report.fix.supported) {
    return ["  Repair: not supported by this scoutd build"];
  }
  if (report.fix.entries.length === 0) {
    return ["  Repair: supported; no actions reported"];
  }

  const lines = ["  Repair actions:"];
  for (const entry of report.fix.entries) {
    const status = entry.status ? ` [${entry.status}]` : "";
    lines.push(`    - ${entry.title}${status}`);
    if (entry.detail) {
      lines.push(`      ${entry.detail}`);
    }
  }
  return lines;
}

export function renderNativeScoutdDoctorSection(report: NativeScoutdDoctorReport): string {
  if (!report.available && !report.fixRequested) {
    return "";
  }

  const lines = ["", "Native daemon:"];
  if (!report.available) {
    lines.push("  scoutd: not found");
    if (report.fixRequested) {
      lines.push("  Repair: not run");
    }
    return lines.join("\n");
  }

  lines.push(`  scoutd: ${report.scoutdPath ?? "unknown"}${report.source ? ` (${report.source})` : ""}`);
  if (report.error) {
    lines.push(`  Error: ${report.error}`);
    lines.push(...renderFixLines(report));
    return lines.join("\n");
  }

  if (report.buildIdentity) {
    lines.push(`  Build: ${report.buildIdentity}`);
  }

  const status = report.status;
  if (status) {
    lines.push(
      `  Label: ${status.label ?? "unknown"}`,
      `  Loaded: ${yesNo(status.loaded)}`,
      `  PID: ${status.pid ?? "-"}`,
      `  Broker reachable: ${yesNo(status.reachable)}`,
    );
    if (status.healthTransport) {
      lines.push(`  Health transport: ${status.healthTransport}`);
    }
    if (status.healthError) {
      lines.push(`  Health error: ${status.healthError}`);
    }
    if (status.brokerSocketPath) {
      lines.push(`  Broker socket: ${status.brokerSocketPath}`);
    }
    if (status.scoutdStatePath) {
      lines.push(`  State file: ${status.scoutdStatePath}`);
    }
    if (status.runtimeFreshness) {
      lines.push(
        `  Runtime freshness: ${status.runtimeFreshness.state}${status.runtimeFreshness.intentional ? " (intentional)" : ""}`,
      );
      if (status.runtimeFreshness.detail) {
        lines.push(`  Runtime detail: ${status.runtimeFreshness.detail}`);
      }
      if (status.runtimeFreshness.reasonCode) {
        lines.push(`  Runtime reason: ${status.runtimeFreshness.reasonCode}`);
      }
    }
  }

  if (report.probes) {
    lines.push(
      "  Probes:",
      `    Socket: ${report.probes.socketPath ?? "-"}`,
      `    Reachable: ${yesNo(report.probes.reachable)}`,
      `    Daemon version: ${report.probes.daemonVersion ?? "-"}`,
    );
    if (report.probes.families.length > 0) {
      lines.push(`    Families: ${report.probes.families.map((family) => family.probeId).join(", ")}`);
    } else {
      lines.push("    Families: none");
    }
    if (report.probes.error) {
      lines.push(`    Error: ${report.probes.error}`);
    }
  }

  if (report.warnings.length === 0) {
    lines.push("  Diagnostics: no native warnings");
  } else {
    lines.push("  Diagnostics:");
    for (const warning of report.warnings) {
      lines.push(`    - ${warning}`);
    }
  }

  lines.push(`  Process observations: ${report.processes.length}`);
  for (const process of report.processes.slice(0, 12)) {
    lines.push(
      `    - pid ${process.pid ?? "-"} ppid ${process.ppid ?? "-"} elapsed ${process.elapsed ?? "-"}: ${compactCommand(process.command)}`,
    );
  }
  if (report.processes.length > 12) {
    lines.push(`    - ... ${report.processes.length - 12} more`);
  }

  lines.push(...renderFixLines(report));
  return lines.join("\n");
}
