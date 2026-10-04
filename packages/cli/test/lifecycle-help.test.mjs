import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
for (const wrapper of ["packages/runtime/bin/openscout-runtime.mjs", "packages/cli/bin/openscout-runtime.mjs", "packages/cli/bin/scout.mjs"]) {
  test(`${wrapper}: help never imports/bootstrap runtime or touches state`, () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-help-"));
    try {
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "home"));
      mkdirSync(join(dir, "dist/runtime"), { recursive: true });
      mkdirSync(join(dir, "dist/node"));
      copyFileSync(join(root, wrapper), join(dir, "bin/entry.mjs"));
      copyFileSync(join(root, "packages/cli/bin/lifecycle-preflight.mjs"), join(dir, "bin/lifecycle-preflight.mjs"));
      writeFileSync(join(dir, "package.json"), '{"version":"test"}');
      // Poison every reachable runtime: importing any entry is a test failure.
      const poison = 'throw new Error("LIFECYCLE ENTRY IMPORTED");';
      for (const command of ["base-daemon", "broker-daemon", "broker-process-manager", "mesh-discover"]) {
        writeFileSync(join(dir, "dist", command + ".js"), poison);
        writeFileSync(join(dir, "dist/runtime", command + ".mjs"), poison);
      }
      for (const entry of ["main.mjs", "node/main.mjs"]) writeFileSync(join(dir, "dist", entry), poison);
      const runtime = !wrapper.endsWith("/scout.mjs");
      const commands = runtime ? [["broker"], ["base"], ["discover"], ...["install", "start", "stop", "restart", "uninstall", "status"].map(a => ["service", a])]
        : [["setup"], ["up", "."], ...["start", "stop", "restart", "status"].map(a => ["app", a])];
      if (!runtime) {
        const run = args => spawnSync(process.execPath, [join(dir, "bin/entry.mjs"), ...args], {
          cwd: dir, timeout: 3000, encoding: "utf8",
          env: { ...process.env, HOME: join(dir, "home"), PATH: "", OPENSCOUT_RUNTIME_HOST: "node" },
        });
        for (const args of [["app", "help"], ["help", "setup"], ["--help", "up"], ["--json", "app", "restart", "--help"], ["relay", "app", "help"]]) {
          const result = run(args);
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /Usage:/);
        }
        for (const args of [
          ["app", "restart", "extra"], ["app", "restart", "--timeout="], ["setup", "--source-root="],
          ["setup", "--context-root", "--source-root=x"], ["--json", "app", "restart", "--unsupported"],
          ["up", ".", "--name="], ["up", ".", "extra"], ["relay", "app", "restart", "extra"],
          ["setup", "--default-harness=unknown"],
        ]) {
          const result = run(args);
          assert.equal(result.status, 1, JSON.stringify(args));
          assert.doesNotMatch(result.stderr, /LIFECYCLE ENTRY IMPORTED/);
          assert.match(result.stderr, /unexpected|invalid|missing/);
        }
        for (const args of [["up", ".", "--json"], ["--json", "up", "."], ["setup", "--source-root=.", "--json"], ["app", "restart", "--timeout=90s"]]) {
          // Valid inputs reach the poisoned runtime; the test never starts services.
          assert.match(run(args).stderr, /LIFECYCLE ENTRY IMPORTED/);
        }
        assert.deepEqual(readdirSync(join(dir, "home")), []);
      }
      for (const args of commands) {
        for (const flag of ["--help", "-h"]) {
          const result = spawnSync(process.execPath, [join(dir, "bin/entry.mjs"), ...args, flag], {
            cwd: dir, timeout: 3000, encoding: "utf8",
            env: { ...process.env, HOME: join(dir, "home"), PATH: "", OPENSCOUT_RUNTIME_HOST: "node", OPENSCOUT_RUNTIME_ENTRYPOINT: "dist" },
          });
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /Usage:/);
          assert.deepEqual(readdirSync(join(dir, "home")), []);
        }
        {
          for (const flag of ["--unsupported", "-x"]) {
            const result = spawnSync(process.execPath, [join(dir, "bin/entry.mjs"), ...args, flag], { cwd: dir, timeout: 3000, encoding: "utf8" });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /Unsupported arguments|unexpected argument/);
            assert.doesNotMatch(result.stderr, /LIFECYCLE ENTRY IMPORTED/);
          }
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
