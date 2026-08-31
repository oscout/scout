import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const readme = readFileSync(resolve(packageDirectory, "README.md"), "utf8");

test("npm metadata points visitors to the OpenScout project", () => {
  assert.equal(packageJson.homepage, "https://openscout.app");
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/oscout/scout.git",
    directory: "packages/cli",
  });
  assert.deepEqual(packageJson.bugs, { url: "https://github.com/oscout/scout/issues" });
  assert.match(packageJson.description, /Local-first control plane/);
  assert.equal(packageJson.engines?.bun, ">=1.3");
  assert.ok(packageJson.files?.includes("NOTICE"), "NOTICE must ship with the Apache-2.0 package");

  for (const keyword of ["ai-agents", "agent-coordination", "local-first", "claude-code", "codex"]) {
    assert.ok(packageJson.keywords?.includes(keyword), `missing npm keyword: ${keyword}`);
  }
});

test("npm README keeps the branded product introduction", () => {
  assert.match(readme, /src="https:\/\/openscout\.app\/og\.png"/);
  assert.match(readme, /The coordination layer for the coding agents you already run\./);
  assert.match(readme, /https:\/\/openscout\.app\/docs\/quickstart/);
  assert.match(readme, /high-trust local developer pilots/);
  assert.match(readme, /The Rust TUI launched by `scout tui`.*not installed by/s);
});
