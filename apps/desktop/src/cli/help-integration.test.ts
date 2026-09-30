import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctorCheck } from "./doctor-checks.ts";

const entry = fileURLToPath(new URL("../../bin/scout.ts", import.meta.url));

test("help and plain status never enter startup maintenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scout-help-test-"));
  try {
    const preload = join(directory, "no-maintenance.ts");
    await writeFile(preload, `import { mock } from "bun:test";
      mock.module(${JSON.stringify(fileURLToPath(new URL("./broker-update.ts", import.meta.url)))}, () => ({
        brokerUpdateDebugEnabled: () => false,
        ensureBrokerUptodate: () => { throw new Error("HELP TRIGGERED MAINTENANCE"); },
      }));`);
    for (const args of [[], ["--help"], ["--version"], ["doctor", "--help"], ["help", "doctor"], ["relay", "doctor", "--help"], ["setup", "--help"], ["runtimes", "--help"], ["status"], ["help", "--detail"]]) {
      const child = Bun.spawn([process.execPath, "--preload", preload, entry, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ args, stderr, code }).toEqual({ args, stderr: "", code: 0 });
      expect(stdout.length).toBeGreaterThan(0);
    }
    const unknown = Bun.spawn([process.execPath, "--preload", preload, entry, "help", "not-a-command"], { stdout: "pipe", stderr: "pipe" });
    expect(await unknown.exited).toBe(1);
    expect(await new Response(unknown.stderr).text()).toContain("unknown command: not-a-command");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("source worker round trip only requests service status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scout-worker-test-"));
  try {
    const runtime = join(directory, "runtime.mjs");
    await writeFile(runtime, `if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["service", "status", "--json"])) process.exit(42);
      console.log(JSON.stringify({health:{reachable:true,ok:true}}));`);
    await chmod(runtime, 0o755);
    const check = await runDoctorCheck("broker", {
      timeoutMs: 2_000, cwd: directory, env: { ...process.env, OPENSCOUT_RUNTIME_BIN: runtime },
      command: [process.execPath, entry, "__doctor-check", "broker"],
    });
    expect(check).toEqual({ name: "broker", state: "working", detail: "Broker health responded OK." });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("default doctor streams partial results and finishes with a concise assessment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scout-doctor-output-test-"));
  try {
    const fixture = join(directory, "fixture.ts");
    const checksModule = fileURLToPath(new URL("./doctor-checks.ts", import.meta.url));
    const mainModule = fileURLToPath(new URL("./main.ts", import.meta.url));
    await writeFile(fixture, `import { mock } from "bun:test";
      import * as actual from ${JSON.stringify(checksModule)};
      const runCheck = actual.runDoctorCheck;
      mock.module(${JSON.stringify(checksModule)}, () => ({ ...actual,
        runDoctorCheck: (name, input) => runCheck(name, { ...input, timeoutMs: 4000 }),
        collectDoctorCheck: async name => {
          if (name === "native") return new Promise(() => setInterval(() => {}, 1000));
          return {name, state: name === "terminal" ? "impaired" : "working",
            detail: name === "terminal" ? "Terminal binding is missing." : "Check completed.",
            ...(name === "terminal" ? {next: "scout doctor --detail"} : {})};
        },
      }));
      await import(${JSON.stringify(mainModule)});`);
    const child = Bun.spawn([process.execPath, fixture, "doctor"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
    expect(stdout).toContain("OK broker: Check completed.");
    expect(stdout).toContain("FAIL terminal: Terminal binding is missing.");
    expect(stdout).toContain("? native: No result within 4s");
    expect(stdout.indexOf("OK broker:")).toBeLessThan(stdout.indexOf("? native:"));
    expect(stdout).toContain("4 working, 1 impaired, 1 inconclusive");
    expect(stdout).toContain("Next: scout doctor --detail");
    expect(stdout.split("\n").length).toBeLessThan(17);
    expect(stdout).not.toContain("Discovering projects");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
