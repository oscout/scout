import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveRuntimeServiceEntrypoint } from "./runtime-service-client.ts";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-runtime-service-client-"));
  tempRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, body = "#!/bin/sh\nexit 0\n"): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

function writeModule(filePath: string, body = "export {};\n"): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

describe("resolveRuntimeServiceEntrypoint", () => {
  test("prefers OPENSCOUT_RUNTIME_BIN over bundled and PATH runtimes", () => {
    const root = createTempRoot();
    const explicitRuntime = writeExecutable(join(root, "custom", "openscout-runtime"));
    writeModule(join(root, "node_modules", "@openscout", "runtime", "bin", "openscout-runtime.mjs"));
    writeExecutable(join(root, "bin", "openscout-runtime"));

    const entrypoint = resolveRuntimeServiceEntrypoint({
      env: {
        HOME: root,
        PATH: join(root, "bin"),
        OPENSCOUT_RUNTIME_BIN: explicitRuntime,
      },
      moduleUrl: pathToFileURL(join(root, "apps", "desktop", "src", "app", "host", "runtime-service-client.ts")),
      currentWorkingDirectory: root,
    });

    expect(entrypoint).toBe(explicitRuntime);
  });

  test("prefers bundled node_modules runtime before PATH runtime", () => {
    const root = createTempRoot();
    const bundledRuntime = writeModule(join(root, "node_modules", "@openscout", "runtime", "bin", "openscout-runtime.mjs"));
    writeExecutable(join(root, "bin", "openscout-runtime"));

    const entrypoint = resolveRuntimeServiceEntrypoint({
      env: {
        HOME: root,
        PATH: join(root, "bin"),
      },
      moduleUrl: pathToFileURL(join(root, "apps", "desktop", "src", "app", "host", "runtime-service-client.ts")),
      currentWorkingDirectory: root,
    });

    expect(entrypoint).toBe(bundledRuntime);
  });

  test("prefers repo runtime before PATH runtime when bundled runtime is absent", () => {
    const root = createTempRoot();
    const repoRuntime = writeModule(join(root, "packages", "runtime", "bin", "openscout-runtime.mjs"));
    writeModule(join(root, "apps", "desktop", "bin", "scout.ts"));
    writeExecutable(join(root, "bin", "openscout-runtime"));

    const entrypoint = resolveRuntimeServiceEntrypoint({
      env: {
        HOME: root,
        PATH: join(root, "bin"),
      },
      moduleUrl: pathToFileURL(join(root, "apps", "desktop", "src", "app", "host", "runtime-service-client.ts")),
      currentWorkingDirectory: join(root, "apps", "desktop"),
    });

    expect(entrypoint).toBe(repoRuntime);
  });
});
