import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyControlPlaneClient, findBasicClientLeaks } from "./bundle-scout-web.mjs";

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
