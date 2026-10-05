import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyControlPlaneClient, findBasicClientLeaks, bundleScoutKnowledgeIndexChildBun, getOpenScoutRepoRoot } from "./bundle-scout-web.mjs";

test("the full-app download keeps runtime portraits, eye patches, pose frames and reachable assets without authoring payload", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-client-copy-"));
  const source = join(root, "source");
  const target = join(root, "packed");
  const retained = ["index.html", "crew/sprout-bust.webp", "crew/sheets/sprout/blink-half.webp", "crew/sheets/eye-plate-v1/rest.webp", "crew/poses/sprout/wave.webp", "characters/sage/sage.glb", "assets/world-outposts-hash.png"];
  const excluded = ["crew-preview.html", "crew/masters/sprout.png", "crew/_runs/frame.webp", "crew/_qa/proof.webp", "crew/poses/sprout/notes.png", "crew/pack.json"];
  try {
    for (const file of [...retained, ...excluded]) {
      mkdirSync(dirname(join(source, file)), { recursive: true });
      writeFileSync(join(source, file), file);
    }
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale.js"), "old build");
    copyControlPlaneClient(source, target, { includeCrew: true });
    for (const file of retained) assert.equal(readFileSync(join(target, file), "utf8"), file);
    for (const file of [...excluded, "stale.js"]) assert.equal(existsSync(join(target, file)), false, file);

    // The public npm package carries no crew artwork at all.
    copyControlPlaneClient(source, target);
    for (const file of retained.filter((f) => !f.startsWith("crew/"))) assert.equal(existsSync(join(target, file)), true, file);
    for (const file of [...retained, ...excluded].filter((f) => f.startsWith("crew"))) assert.equal(existsSync(join(target, file)), false, file);
    // Packing cannot remove the source files used by authoring tools.
    for (const file of excluded) assert.equal(existsSync(join(source, file)), true, file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("basic client check passes a Home/DMs/Tail build and names each full-app leak", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-basic-client-"));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  try {
    write("index.html", '<script type="module" src="/assets/index-abc.js"></script>');
    write("assets/index-abc.js", "export const nav=['Home','DMs','Tail'];");
    write("crew/sprout-bust.webp", "img");
    assert.deepEqual(findBasicClientLeaks(root), []);

    write("assets/ops-def.js", "const title='Mission Control';");
    write("characters/sage/sage.glb", "glb");
    assert.deepEqual(findBasicClientLeaks(root).sort(), [
      'assets/ops-def.js: "Mission Control"',
      "characters/: ops 3D studio assets",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI indexing child runs from a relocated installed-style dist fixture", () => {
  const repo = getOpenScoutRepoRoot();
  // Resolve normal runtime dependencies through this lane's install, while the
  // emitted child itself has no source-tree sibling or source-relative imports.
  const root = mkdtempSync(join(repo, "packages/cli/node_modules/.child-bundle-test-"));
  const output = join(root, "dist/knowledge-index-child.mjs");
  try {
    assert.equal(bundleScoutKnowledgeIndexChildBun(repo, output), true);
    const transcripts = join(root, "claude/project");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, "fixture.jsonl"), JSON.stringify({
      type: "user", cwd: root, sessionId: "packed-child-fixture",
      message: { role: "user", content: "A packaged indexing child can read this fixture." },
    }) + "\n");
    const run = spawnSync("bun", [output, JSON.stringify({ harness: "claude", limit: 1 })], {
      cwd: root, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, OPENSCOUT_CONTROL_HOME: join(root, "control"),
        OPENSCOUT_SUPPORT_DIRECTORY: join(root, "support"),
        OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT: join(root, "claude") },
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const outcome = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.discovered, 1);
    assert.equal(outcome.result.failed, 0);
    assert.ok(outcome.status.chunks > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
