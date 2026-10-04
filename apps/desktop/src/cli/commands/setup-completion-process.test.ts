import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Separate processes keep module mocks out of the other command tests. The
// setup service is synthetic; actual command output and process exit are not.
for (const mode of ["plain", "json"] as const) {
  for (const status of ["error", "missing", "skipped", "ready", "installed"]) {
    test(`setup process ${mode}: local edge ${status}`, () => {
      const home = mkdtempSync(join(tmpdir(), "scout-setup-process-"));
      try {
        const brew = join(home, "brew");
        writeFileSync(brew, "#!/bin/sh\necho 'fixture: attempted Caddy install failed' >&2\nexit 7\n");
        chmodSync(brew, 0o755);
        const service = resolve(import.meta.dir, "../../core/setup/service.ts");
        const command = resolve(import.meta.dir, "setup.ts");
        const context = resolve(import.meta.dir, "../context.ts");
        const dependencies = resolve(import.meta.dir, "../../core/setup/local-edge-dependencies.ts");
        const child = join(home, "child.ts");
        writeFileSync(child, `
import { mock } from "bun:test";
import { ensureScoutLocalEdgeDependencies } from ${JSON.stringify(dependencies)};
const attempted = ensureScoutLocalEdgeDependencies({
  env: { HOME: ${JSON.stringify(home)}, PATH: ${JSON.stringify(home)} },
  platform: "darwin", commonDirectories: [],
});
if (attempted.status !== "error" || !attempted.detail.includes("attempted Caddy install failed")) throw new Error("fixture did not attempt installation");
const report = {
  currentDirectory: ${JSON.stringify(home)},
  setup: { supportDirectory: "fixture", settingsPath: "fixture", harnessCatalogPath: "fixture",
    relayAgentsPath: "fixture", managedInstallsPath: "fixture", currentProjectConfigPath: null,
    createdProjectConfig: false, projectInventory: [],
    settings: { discovery: { workspaceRoots: [] }, agents: { defaultHarness: "codex" } } },
  broker: { health: { ok: true }, reachable: true, serviceAdapter: "headless-foreground",
    label: "fixture", brokerUrl: "http://127.0.0.1:1", stdoutLogPath: "fixture", stderrLogPath: "fixture" },
  brokerWarning: null,
  catalog: { entries: [{ name: "codex", label: "Codex", harness: "codex",
    readinessReport: { state: "ready", ready: true, detail: "synthetic" } }] },
  scoutSkill: { entries: [] }, claudeStatusline: { status: "skipped", wrapperPath: "fixture" },
  localEdge: { ...attempted, status: ${JSON.stringify(status)},
    detail: ${status === "error" ? "attempted.detail" : JSON.stringify(`optional edge fixture: ${status}`)} },
};
mock.module(${JSON.stringify(service)}, () => ({ runScoutSetup: async () => report }));
const { runSetupCommand } = await import(${JSON.stringify(command)});
const { createScoutCommandContext } = await import(${JSON.stringify(context)});
await runSetupCommand(createScoutCommandContext({ cwd: ${JSON.stringify(home)}, outputMode: ${JSON.stringify(mode)}, isTty: false }), ["--source-root", ${JSON.stringify(home)}]);
`);
        const env = { ...process.env, HOME: home, OPENSCOUT_HOME: join(home, ".openscout"),
          OPENSCOUT_SUPPORT_DIRECTORY: join(home, "support"), OPENSCOUT_CONTROL_HOME: join(home, "control"),
          OPENSCOUT_RELAY_HUB: join(home, "relay") };
        const result = Bun.spawnSync([process.execPath, child], { env, timeout: 20_000 });
        const stdout = result.stdout.toString();
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(status === "error" ? 1 : 0);
        const headline = status === "error" ? "Scout setup failed." : "Scout is ready.";
        if (mode === "json") {
          const report = JSON.parse(stdout);
          expect(report.outcome).toBe(status === "error" ? "failed" : "ready");
          expect(report.headline).toBe(headline);
          expect(report.localEdge.status).toBe(status);
          expect(report.nextStep).toBe(status === "error" ? "scout setup" : "scout whoami");
        } else {
          expect(stdout).toContain(headline);
          if (status === "error") expect(stdout).toContain("fixture: attempted Caddy install failed");
        }
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  }
}
