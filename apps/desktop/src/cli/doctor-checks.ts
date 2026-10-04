import type { ScoutCommandContext } from "./context.ts";
import { getRuntimeBrokerServiceStatus } from "../app/host/runtime-service-client.ts";
import { loadScoutLocalEdgeDoctorReport } from "../core/setup/service.ts";
import { inspectScoutTerminalPtyDependencies } from "../core/setup/terminal-pty-dependencies.ts";
import { loadSystemProbeDoctorReport } from "@openscout/runtime/system-probes";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import { loadNativeScoutdDoctorReport, type NativeScoutdDoctorReport } from "./scoutd.ts";
import { spawn } from "node:child_process";

export const DOCTOR_CHECK_NAMES = ["broker", "native", "runtimes", "local-edge", "terminal", "probes"] as const;
export type DoctorCheckName = typeof DOCTOR_CHECK_NAMES[number];
export type DoctorCheck = {
  name: DoctorCheckName;
  state: "working" | "impaired" | "inconclusive";
  detail: string;
  next?: string;
};
export const DOCTOR_CHECK_TIMEOUT_MS = 6_000;
const NEXT_DETAIL = "scout doctor --detail";
const brief = (text: string): string => text.replace(/\s+/g, " ").slice(0, 220);

export function doctorBrokerCheck(broker: Awaited<ReturnType<typeof getRuntimeBrokerServiceStatus>>): DoctorCheck {
  // A transport failure cannot prove that the broker is unhealthy. A received
  // health response can; preserve the service's health semantics verbatim.
  if (!broker.health.reachable || ["timed_out", "unknown", "cancelled"].includes(broker.health.state ?? "")) return {
    name: "broker", state: "inconclusive", detail: "Health response unavailable; service state is unknown.",
    next: "scout doctor --detail",
  };
  // Alive but unable to write: every send fails while health still says ok.
  const journalWrites = broker.health.storage?.journal;
  if (broker.health.ok && journalWrites?.state === "failing") return {
    name: "broker", state: "impaired",
    detail: brief(`Broker is up but journal writes are failing (${journalWrites.code ?? journalWrites.error}); messages will not be recorded.`),
    next: journalWrites.code === "ENOSPC" ? "Free disk space; writes resume on their own." : NEXT_DETAIL,
  };
  return {
    name: "broker", state: broker.health.ok ? "working" : "impaired",
    detail: broker.health.ok ? "Broker health responded OK." : "Broker responded with unhealthy status.",
    ...(!broker.health.ok ? { next: "scout doctor --detail" } : {}),
  };
}

export function doctorNativeCheck(report: NativeScoutdDoctorReport): DoctorCheck {
  if (report.notApplicableDetail) return {
    name: "native", state: "working", detail: report.notApplicableDetail,
  };
  if (!report.available || report.error || !report.status) return {
    name: "native", state: "inconclusive", detail: "Native diagnostics unavailable; daemon state is unknown.", next: NEXT_DETAIL,
  };
  const freshness = report.status.runtimeFreshness;
  if (["timed_out", "unknown", "cancelled"].includes(report.status.healthState ?? "") && freshness?.state !== "stale") return {
    name: "native", state: "inconclusive", detail: "Native health check was inconclusive; daemon readiness is unknown.", next: NEXT_DETAIL,
  };
  const impaired = report.status.healthOk === false && report.status.reachable === true
    || freshness?.state === "stale" || report.warnings.length > 0;
  return { name: "native", state: impaired ? "impaired" : report.status.healthOk === true ? "working" : "inconclusive",
    detail: impaired ? `Native diagnostics: ${freshness?.state === "stale" ? "runtime is stale" : "service health or warnings need attention"}.`
      : report.status.healthOk === true ? "Native daemon reports healthy service." : "Native health has not been confirmed.",
    ...(impaired || report.status.healthOk !== true ? { next: NEXT_DETAIL } : {}),
  };
}

/** Internal read-only worker. Never routes through startup maintenance. */
export async function collectDoctorCheck(name: DoctorCheckName, context: ScoutCommandContext): Promise<DoctorCheck> {
  switch (name) {
    case "broker": return doctorBrokerCheck(await getRuntimeBrokerServiceStatus());
    case "native": {
      const report = await loadNativeScoutdDoctorReport({ env: context.env });
      return doctorNativeCheck(report);
    }
    case "runtimes": {
      const catalog = await loadHarnessCatalogSnapshot();
      const ready = catalog.entries.filter(entry => entry.readinessReport.ready);
      return { name, state: ready.length ? "working" : "impaired",
        detail: `${ready.length} of ${catalog.entries.length} runtimes ready.`,
        ...(!ready.length ? { next: "scout runtimes" } : {}),
      };
    }
    case "local-edge": {
      const report = await loadScoutLocalEdgeDoctorReport(context.env);
      const dnsTimedOut = [report.dns.portal, report.dns.node].some(host => host.error?.includes("timed out"));
      const knownImpairment = !["ready", "installed"].includes(report.dependency.status)
        || (!report.listeners.http.listening && !report.listeners.https.listening)
        || (report.listeners.https.listening && !["trusted", "installed"].includes(report.dependency.trust.status));
      if (dnsTimedOut && !knownImpairment) return {
        name, state: "inconclusive", detail: "Local hostname resolution timed out; web routing is unconfirmed.", next: NEXT_DETAIL,
      };
      return { name, state: report.state === "ready" ? "working" : "impaired",
        detail: report.state === "ready" ? "Local web routing is ready." : "Local web routing or HTTPS trust is not ready.",
        ...(report.state !== "ready" ? { next: NEXT_DETAIL } : {}),
      };
    }
    case "terminal": {
      const report = inspectScoutTerminalPtyDependencies({ env: context.env });
      return { name, state: report.status === "ready" ? "working" : "impaired",
        detail: report.status === "ready" ? "Terminal dependencies passed their smoke test." : `Terminal dependencies: ${report.status}.`,
        ...(report.status !== "ready" ? { next: report.installCommand ?? NEXT_DETAIL } : {}),
      };
    }
    case "probes": {
      const report = await loadSystemProbeDoctorReport({ repoRoot: context.cwd });
      const unhealthy = report.families.filter(family => family.status === "failed");
      const unknown = report.families.filter(family => family.status === "empty" || family.status === "stale");
      return { name, state: unhealthy.length || report.warnings.length ? "impaired" : report.families.length && !unknown.length ? "working" : "inconclusive",
        detail: `${report.families.length} probe families observed; ${unhealthy.length} failed, ${unknown.length} inconclusive, ${report.warnings.length} warnings.`,
        ...(unhealthy.length || report.warnings.length || unknown.length || !report.families.length ? { next: NEXT_DETAIL } : {}),
      };
    }
  }
}

export function doctorWorkerCommand(execPath = process.execPath, scriptPath = process.argv[1]): string[] {
  // Bun's compiled executable has a virtual entry point. Source and packaged
  // JS entry points instead need to be passed back to the Bun executable.
  return scriptPath && !scriptPath.includes("/$bunfs/") ? [execPath, scriptPath] : [execPath];
}

/** Process isolation bounds even synchronous dependency probes. Only this
 * diagnostic's process group is stopped; no existing service is touched. */
export async function runDoctorCheck(
  name: DoctorCheckName,
  input: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; command?: string[] },
): Promise<DoctorCheck> {
  const command = input.command ?? [...doctorWorkerCommand(), "__doctor-check", name];
  return new Promise(resolve => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let stdout = "";
    let settled = false;
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already reaped */ }
    };
    const finish = (result: DoctorCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("exit", stop);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      stop();
      resolve(result);
    };
    const interrupt = () => { stop(); process.exit(130); };
    const terminate = () => { stop(); process.exit(143); };
    process.once("exit", stop);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const timer = setTimeout(() => finish({ name, state: "inconclusive",
      detail: `No result within ${(input.timeoutMs ?? DOCTOR_CHECK_TIMEOUT_MS) / 1000}s; service state is unknown.`,
      next: "Retry scout doctor; use scout doctor --detail if it persists.",
    }), input.timeoutMs ?? DOCTOR_CHECK_TIMEOUT_MS);
    child.stdout.on("data", data => {
      stdout += data.toString();
      if (stdout.length > 1_048_576) finish({ name, state: "inconclusive", detail: "Diagnostic output exceeded its limit.", next: NEXT_DETAIL });
    });
    child.stderr.resume();
    child.on("error", () => finish({ name, state: "inconclusive", detail: "Diagnostic could not start.", next: NEXT_DETAIL }));
    child.on("close", code => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout) as DoctorCheck;
        if (code !== 0 || result.name !== name || !["working", "impaired", "inconclusive"].includes(result.state) || typeof result.detail !== "string") throw new Error("invalid result");
        finish(result);
      } catch {
        finish({ name, state: "inconclusive", detail: "Diagnostic failed to return a valid result; service state is unknown.", next: NEXT_DETAIL });
      }
    });
  });
}

export function renderDoctorCheck(check: DoctorCheck): string {
  return `${check.state === "working" ? "OK" : check.state === "impaired" ? "FAIL" : "?"} ${check.name}: ${brief(check.detail)}`;
}

export function renderDoctorAssessment(checks: DoctorCheck[]): string {
  const working = checks.filter(check => check.state === "working");
  const impaired = checks.filter(check => check.state === "impaired");
  const unknown = checks.filter(check => check.state === "inconclusive");
  const next = checks.find(check => check.name === "broker" && check.state !== "working")?.next
    ?? impaired.find(check => check.next)?.next ?? unknown.find(check => check.next)?.next;
  return [
    `Assessment: ${impaired.length ? "impaired" : unknown.length ? "inconclusive" : "ready"} — ${working.length} working, ${impaired.length} impaired, ${unknown.length} inconclusive.`,
    `Works: ${working.map(check => check.name).join(", ") || "none confirmed"}.`,
    ...(impaired.length ? [`Impaired: ${impaired.map(check => check.name).join(", ")}.`] : []),
    ...(unknown.length ? [`Inconclusive: ${unknown.map(check => check.name).join(", ")} (not a confirmed failure).`] : []),
    `Next: ${next ?? "scout who — find agents to work with."}`,
    "Inventory and paths: scout doctor --detail. Machine-readable: scout doctor --json.",
  ].join("\n");
}
