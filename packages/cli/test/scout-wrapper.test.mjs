import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(testDirectory, "..");

test("scout wrapper exposes the new Scout CLI surface", () => {
  const output = execFileSync("bun", ["./bin/scout.mjs", "--help"], {
    cwd: packageDirectory,
    encoding: "utf8",
  });

  assert.match(output, /\bsetup\b/);
  assert.match(output, /\bpair\b/);
  assert.match(output, /\bserver\b/);
  assert.match(output, /Implicit ask shortcut:/);
  assert.match(output, /scout @agent your request/);
  assert.match(output, /Compatibility:/);
  assert.match(output, /\binit\b/);
  assert.doesNotMatch(output, /\bscout dev\b/);
});

test("scout wrapper exposes current ask routing help", () => {
  const output = execFileSync("bun", ["./bin/scout.mjs", "ask", "--help"], {
    cwd: packageDirectory,
    encoding: "utf8",
  });

  assert.match(output, /--harness <runtime> with no target/);
  assert.match(output, /--new/);
  assert.match(output, /scout ask --harness codex/);
});

test("scout wrapper rejects unsupported ask session reuse before routing", () => {
  assert.throws(
    () => execFileSync(
      "bun",
      ["./bin/scout.mjs", "ask", "--session", "reuse", "--harness", "codex", "smoke"],
      {
        cwd: packageDirectory,
        encoding: "utf8",
        stdio: "pipe",
      },
    ),
    (error) => {
      assert.match(error.stderr.toString(), /invalid session: reuse/);
      return true;
    },
  );
});
