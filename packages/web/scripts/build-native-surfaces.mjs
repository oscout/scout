#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const repoRoot = resolve(packageDirectory, "../..");
const outputDirectory = resolve(repoRoot, "apps/ios/Scout/Resources/WebSurfaces");

if (!existsSync(resolve(repoRoot, "apps/ios"))) {
  console.error(
    "Native web surfaces compile into the private iOS app (apps/ios). They are not part of the public oscout/scout check surface.",
  );
  process.exit(1);
}

for (const [index, surface] of ["lanes", "deck", "dispatch", "chat"].entries()) {
  const build = spawnSync(
    "vite",
    ["build", "--config", "vite.native-surfaces.config.ts", ...(index === 0 ? [] : ["--emptyOutDir", "false"])],
    {
      cwd: packageDirectory,
      stdio: "inherit",
      env: { ...process.env, SCOUT_NATIVE_SURFACE: surface },
    },
  );
  if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);
}

for (const [surface, title] of [["lanes", "Scout Lanes"], ["deck", "Scout Deck"], ["dispatch", "Scout Dispatch"], ["chat", "Scout Chat"]]) {
  const imagePolicy = surface === "chat" ? "'self' data: blob:" : "'self' data:";
  const mediaPolicy = surface === "chat" ? " media-src 'self' blob:;" : "";
  writeFileSync(resolve(outputDirectory, surface, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src ${imagePolicy};${mediaPolicy} font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'" />
    <title>${title}</title>
    <link rel="stylesheet" href="./app.css" />
    <script defer src="./app.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function walk(directory) {
  return readdirSync(directory)
    .flatMap((name) => {
      const absolute = resolve(directory, name);
      return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    })
    .sort();
}

const files = walk(outputDirectory)
  .filter((file) => relative(outputDirectory, file) !== "manifest.json")
  .map((file) => ({
    path: relative(outputDirectory, file).replaceAll("\\", "/"),
    sha256: sha256(readFileSync(file)),
    bytes: statSync(file).size,
  }));

const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout?.trim() || null;
const lockfile = readFileSync(resolve(repoRoot, "bun.lock"));
const assetRevision = sha256(
  files.map((file) => `${file.path}:${file.sha256}`).join("\n"),
).slice(0, 16);

const manifest = {
  schemaVersion: 1,
  assetRevision,
  protocol: { minimum: 1, maximum: 1 },
  toolchain: {
    node: process.versions.node,
    bun: bunVersion,
    vite: packageJson.devDependencies.vite,
    lockfileSha256: sha256(lockfile),
  },
  surfaces: {
    lanes: {
      entry: "lanes/index.html",
      capabilities: [
        "bootstrap",
        "native.openExternalURL",
        "native.getPreferences",
        "native.setPreferences",
        "native.cancel",
        "agents.list",
        "agents.observe",
        "tail.recent",
        "tail.subscribe",
        "native.setLaneSelection",
      ],
      preferences: [
        "lanes.layout",
        "lanes.horizon",
        "lanes.gridColumns",
        "lanes.collapseTechnicalEvents",
      ],
    },
    deck: {
      entry: "deck/index.html",
      capabilities: [
        "bootstrap",
        "native.openExternalURL",
        "native.getPreferences",
        "native.setPreferences",
        "native.cancel",
        "native.voice.snapshot",
        "native.voice.toggleInput",
        "native.voice.speak",
        "native.voice.stopOutput",
        "agents.list",
        "agents.observe",
        "tail.recent",
        "tail.subscribe",
        "native.setLaneSelection",
        "codex.session.start",
        "codex.thread.snapshot",
        "codex.thread.connect",
        "codex.turn.start",
        "codex.turn.steer",
        "codex.turn.interrupt",
      ],
      preferences: [],
    },
    dispatch: {
      entry: "dispatch/index.html",
      capabilities: [
        "bootstrap",
        "native.openExternalURL",
        "native.getPreferences",
        "native.setPreferences",
        "native.cancel",
        "dispatch.diagnostics",
        "dispatch.subscribe",
        "dispatch.ask",
        "dispatch.review",
      ],
      preferences: ["dispatch.density"],
    },
    chat: {
      entry: "chat/index.html",
      capabilities: [
        "bootstrap",
        "chat.snapshot",
        "chat.send",
        "chat.upload",
        "chat.attachment.fetch",
        "chat.markRead",
        "chat.interrupt",
        "chat.answer",
        "chat.decide",
        "native.voice.snapshot",
        "native.voice.toggleInput",
        "native.close",
      ],
      preferences: ["scout.chat.renderer", "scout.chat.style", "scout.chat.mode", "scout.chat.density"],
    },
  },
  files,
};

writeFileSync(
  resolve(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`native surfaces ${assetRevision} · ${files.length} files`);
