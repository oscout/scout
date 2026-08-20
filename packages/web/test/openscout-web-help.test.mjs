import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(testDirectory, "..");

test("openscout-web --help does not require dist", () => {
  const output = execFileSync("node", [path.join(packageDirectory, "bin", "openscout-web.mjs"), "--help"], {
    cwd: packageDirectory,
    encoding: "utf8",
  });

  assert.match(output, /openscout-web/);
  assert.match(output, /--port/);
  assert.match(output, /--public-origin/);
  assert.match(output, /standalone Bun server/i);
});
