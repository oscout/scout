import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyControlPlaneClient } from "./bundle-scout-web.mjs";

test("packaged client keeps runtime portraits, eye patches and reachable assets without authoring payload", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-client-copy-"));
  const source = join(root, "source");
  const target = join(root, "packed");
  const retained = ["index.html", "crew/sprout-bust.webp", "crew/sheets/sprout/blink-half.webp", "crew/sheets/eye-plate-v1/rest.webp", "characters/sage/sage.glb", "assets/world-outposts-hash.png"];
  const excluded = ["crew-preview.html", "crew/masters/sprout.png", "crew/_runs/frame.webp", "crew/_qa/proof.webp", "crew/poses/wave.webp", "crew/pack.json"];
  try {
    for (const file of [...retained, ...excluded]) {
      mkdirSync(dirname(join(source, file)), { recursive: true });
      writeFileSync(join(source, file), file);
    }
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale.js"), "old build");
    copyControlPlaneClient(source, target);
    for (const file of retained) assert.equal(readFileSync(join(target, file), "utf8"), file);
    for (const file of [...excluded, "stale.js"]) assert.equal(existsSync(join(target, file)), false, file);
    // Packing cannot remove the source files used by authoring tools.
    for (const file of excluded) assert.equal(existsSync(join(source, file)), true, file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
