import { expect, test } from "bun:test";
import { doctorBrokerCheck, doctorNativeCheck, doctorWorkerCommand, renderDoctorAssessment, renderDoctorCheck, runDoctorCheck } from "./doctor-checks.ts";
import type { BrokerServiceStatus } from "@openscout/runtime/broker-process-manager";

const input = { cwd: process.cwd(), env: process.env };

test("transport failure is inconclusive, while a received unhealthy result is impaired", () => {
  const broker = (reachable: boolean, ok: boolean) => ({ health: { reachable, ok } }) as BrokerServiceStatus;
  expect(doctorBrokerCheck(broker(false, false)).state).toBe("inconclusive");
  expect(doctorBrokerCheck(broker(true, false)).state).toBe("impaired");
  expect(doctorBrokerCheck(broker(true, true)).state).toBe("working");
  expect(doctorBrokerCheck({ ...broker(true, false), health: { ...broker(true, false).health, state: "timed_out" } }).state).toBe("inconclusive");
});

test("a live broker whose journal writes fail is impaired", () => {
  const check = doctorBrokerCheck({ health: { reachable: true, ok: true, storage: { journal: {
    state: "failing", since: 1, lastFailedAt: 2, failures: 4, code: "ENOSPC", error: "ENOSPC: no space left on device, write",
  } } } } as BrokerServiceStatus);
  expect(check.state).toBe("impaired");
  expect(check.detail).toContain("journal writes are failing (ENOSPC)");
  expect(doctorBrokerCheck({ health: { reachable: true, ok: true, storage: { journal: { state: "ok" } } } } as BrokerServiceStatus).state).toBe("working");
});

test("one stalled subprocess does not prevent useful checks from finishing", async () => {
  const completed: string[] = [];
  const slow = runDoctorCheck("native", { ...input, timeoutMs: 150,
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  }).then(result => { completed.push(result.name); return result; });
  const fast = runDoctorCheck("broker", { ...input, timeoutMs: 1_000,
    command: [process.execPath, "-e", 'console.log(JSON.stringify({ name: "broker", state: "working", detail: "Health responded OK." }))'],
  }).then(result => { completed.push(result.name); return result; });
  const [unknown, working] = await Promise.all([slow, fast]);
  expect(completed).toEqual(["broker", "native"]);
  expect(unknown.state).toBe("inconclusive");
  expect(unknown.detail).toContain("No result within");
  expect(working.state).toBe("working");
  const assessment = renderDoctorAssessment([working, unknown]);
  expect(assessment).toContain("1 working, 0 impaired, 1 inconclusive");
  expect(assessment).toContain("not a confirmed failure");
  expect(assessment).toContain("Next:");
});

test("bad output, failed launch and failed diagnostic are inconclusive", async () => {
  for (const command of [
    [process.execPath, "-e", 'console.log("not json")'],
    [process.execPath, "-e", "process.exit(1)"],
    ["/does-not-exist/scout"],
  ]) {
    expect((await runDoctorCheck("broker", { ...input, command })).state).toBe("inconclusive");
  }
});

test("source, bundled JS and compiled entry points relaunch correctly", () => {
  expect(doctorWorkerCommand("/bin/bun", "/repo/scout.ts")).toEqual(["/bin/bun", "/repo/scout.ts"]);
  expect(doctorWorkerCommand("/bin/bun", "/pkg/main.mjs")).toEqual(["/bin/bun", "/pkg/main.mjs"]);
  expect(doctorWorkerCommand("/bin/scout", "/$bunfs/root/scout.ts")).toEqual(["/bin/scout"]);
});

test("assessment stays bounded and selects the impaired check's next action", () => {
  const check = { name: "terminal" as const, state: "impaired" as const, detail: "missing binding", next: "scout doctor --detail" };
  expect(renderDoctorCheck(check)).toBe("FAIL terminal: missing binding");
  const text = renderDoctorAssessment([check]);
  expect(text).toContain("Assessment: impaired");
  expect(text).toContain("Next: scout doctor --detail");
  expect(text.split("\n").length).toBeLessThan(8);
});

test("deadline reaps the diagnostic process instead of leaving it running", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "scout-deadline-test-"));
  try {
    const pidFile = join(directory, "pid");
    const result = await runDoctorCheck("native", { ...input, timeoutMs: 250,
      command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
    });
    expect(result.state).toBe("inconclusive");
    const pid = Number(await readFile(pidFile, "utf8"));
    // SIGKILL was sent before settlement; allow the OS to deliver and reap it.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("native connected timeout remains inconclusive, while observed failure and stale code remain impaired", () => {
  const report = {
    available: true, error: null, warnings: ["Broker health probe timed out after connecting"],
    status: { reachable: true, healthOk: false, healthState: "timed_out", runtimeFreshness: { state: "current" } },
  } as unknown as Parameters<typeof doctorNativeCheck>[0];
  expect(doctorNativeCheck(report).state).toBe("inconclusive");
  expect(doctorNativeCheck({ ...report, status: { ...report.status!, healthState: "degraded" } }).state).toBe("impaired");
  expect(doctorNativeCheck({ ...report, status: { ...report.status!, runtimeFreshness: { ...report.status!.runtimeFreshness!, state: "stale" } } }).state).toBe("impaired");
});
