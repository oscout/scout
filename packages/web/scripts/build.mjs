#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const outputDirectory = resolve(packageDirectory, "dist");

const clientBuild = spawnSync("vite", ["build"], {
  cwd: packageDirectory,
  stdio: "inherit",
});

if ((clientBuild.status ?? 1) !== 0) {
  process.exit(clientBuild.status ?? 1);
}

mkdirSync(outputDirectory, { recursive: true });

const entries = [
  {
    input: resolve(packageDirectory, "server", "index.ts"),
    output: resolve(outputDirectory, "openscout-web-server.mjs"),
    target: "bun",
  },
  {
    input: resolve(packageDirectory, "server", "pairing-runtime-controller.ts"),
    output: resolve(outputDirectory, "pairing-runtime-controller.mjs"),
    target: "bun",
  },
  {
    input: resolve(packageDirectory, "server", "knowledge-index-child.ts"),
    output: resolve(outputDirectory, "knowledge-index-child.mjs"),
    target: "bun",
  },
  {
    input: resolve(packageDirectory, "server", "terminal-relay-node.ts"),
    output: resolve(outputDirectory, "openscout-terminal-relay.mjs"),
    target: "node",
  },
];

for (const entry of entries) {
  const result = spawnSync(
    "bun",
    [
      "build",
      entry.input,
      "--target",
      entry.target,
      "--format=esm",
      "--outfile",
      entry.output,
      "--external",
      "vite",
      ...(entry.target === "node" ? ["--external", "@lydell/node-pty"] : []),
    ],
    {
      cwd: packageDirectory,
      stdio: "inherit",
    },
  );
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
