import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import {
  repoServiceTransportMetadata,
  resetRepoServiceTransportForTests,
  runRepoServiceJson,
  setRepoServiceSpawnForTests,
  type RepoServiceCommand,
} from "./process.js";

const originalSocket = process.env.OPENSCOUT_PROBES_SOCKET;

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "openscout-repo-service-transport-"));
  resetRepoServiceTransportForTests();
});

afterEach(() => {
  resetRepoServiceTransportForTests();
  if (originalSocket === undefined) delete process.env.OPENSCOUT_PROBES_SOCKET;
  else process.env.OPENSCOUT_PROBES_SOCKET = originalSocket;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("repo-service scoutd transport", () => {
  test("routes repo scan over scoutd without spawning", async () => {
    const socketPath = join(tempRoot, "probes.sock");
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    const requests: Array<Record<string, unknown>> = [];
    const server = await startRepoServer(socketPath, (request) => {
      requests.push(request);
      if (request.schema === "openscout.probe.capabilities/v1") return capabilities();
      return repoEnvelope("repo.scan", {
        schema: "openscout.repo.scan/v1",
        generatedAt: 1,
        projects: [],
        coverage: {},
        diagnostics: [],
      });
    });
    let spawns = 0;
    setRepoServiceSpawnForTests((() => {
      spawns += 1;
      throw new Error("spawn should not be used when scoutd serves repo.scan");
    }) as never);

    try {
      const output = await runRepoServiceJson(null, { hints: [], limits: {} }, 1_000, "scan");

      expect(spawns).toBe(0);
      expect(output).toMatchObject({ schema: "openscout.repo.scan/v1", projects: [] });
      expect(repoServiceTransportMetadata(output)).toMatchObject({
        backend: "scoutd",
        daemonVersion: "test-daemon",
      });
      expect(requests.map((request) => request.schema)).toEqual([
        "openscout.probe.capabilities/v1",
        "openscout.repo.scan/v1",
      ]);
      expect(requests[1]?.schemaVersion).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  test("falls back after an in-flight daemon failure and re-adopts scoutd later", async () => {
    const socketPath = join(tempRoot, "probes.sock");
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    const fallbackCommand = writeFallbackRepoService();
    let jobCount = 0;
    const server = await startRepoServer(socketPath, (request, socket) => {
      if (request.schema === "openscout.probe.capabilities/v1") return capabilities();
      jobCount += 1;
      if (jobCount === 1) {
        socket.destroy();
        return null;
      }
      return repoEnvelope("repo.scan", {
        schema: "openscout.repo.scan/v1",
        generatedAt: 3,
        projects: [{ root: "/socket", commonGitDir: "/socket/.git", worktrees: [] }],
        coverage: {},
        diagnostics: [],
      });
    });

    try {
      const fallback = await runRepoServiceJson(fallbackCommand, { hints: [], limits: {} }, 1_000);
      expect(fallback).toMatchObject({ schema: "openscout.repo.scan/v1", projects: [] });
      expect(repoServiceTransportMetadata(fallback)).toMatchObject({
        backend: "spawn-fallback",
      });
      expect(repoServiceTransportMetadata(fallback)?.fallbackReason).toMatch(/closed|reset|response|socket/i);

      const readopted = await runRepoServiceJson(fallbackCommand, { hints: [], limits: {} }, 1_000);
      expect(readopted).toMatchObject({
        schema: "openscout.repo.scan/v1",
        projects: [{ root: "/socket" }],
      });
      expect(repoServiceTransportMetadata(readopted)).toMatchObject({ backend: "scoutd" });
    } finally {
      await closeServer(server);
    }
  });

  test("falls back without sending a repo request when a repo capability schema version differs", async () => {
    const socketPath = join(tempRoot, "probes.sock");
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    const fallbackCommand = writeFallbackRepoService();
    const requests: Array<Record<string, unknown>> = [];
    const server = await startRepoServer(socketPath, (request) => {
      requests.push(request);
      if (request.schema === "openscout.probe.capabilities/v1") return capabilities(2);
      throw new Error("repo request should not be sent when schema versions differ");
    });

    try {
      const output = await runRepoServiceJson(fallbackCommand, { hints: [], limits: {} }, 1_000, "scan");

      expect(output).toMatchObject({ schema: "openscout.repo.scan/v1", projects: [] });
      expect(repoServiceTransportMetadata(output)).toMatchObject({
        backend: "spawn-fallback",
        fallbackReason: expect.stringContaining("schema v2"),
      });
      expect(requests).toEqual([{ schema: "openscout.probe.capabilities/v1" }]);
    } finally {
      await closeServer(server);
    }
  });
});

function fakeCommand(subcommand: "scan" | "diff"): RepoServiceCommand {
  return {
    command: "/no/spawn/expected",
    args: [subcommand],
    subcommand,
  };
}

function writeFallbackRepoService(): RepoServiceCommand {
  const script = join(tempRoot, "repo-service-fallback.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    "cat >/dev/null",
    "printf '%s\\n' '{\"schema\":\"openscout.repo.scan/v1\",\"generatedAt\":2,\"projects\":[],\"coverage\":{},\"diagnostics\":[]}'",
  ].join("\n"));
  chmodSync(script, 0o755);
  return { command: script, args: ["scan"], subcommand: "scan" };
}

async function startRepoServer(
  socketPath: string,
  handler: (request: Record<string, unknown>, socket: Socket) => unknown,
): Promise<Server> {
  const server = createServer((socket) => {
    let raw = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      raw += chunk;
      if (handled || !raw.includes("\n")) return;
      handled = true;
      const line = raw.slice(0, raw.indexOf("\n"));
      const response = handler(JSON.parse(line) as Record<string, unknown>, socket);
      if (response !== null) {
        socket.end(`${JSON.stringify(response)}\n`);
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

function capabilities(schemaVersion = 1): Record<string, unknown> {
  return {
    schema: "openscout.probe.capabilities/v1",
    daemonVersion: "test-daemon",
    families: [
      { probeId: "repo.scan", schemaVersion, ttlMs: 0 },
      { probeId: "repo.diff", schemaVersion, ttlMs: 0 },
    ],
  };
}

function repoEnvelope(operation: string, value: unknown): Record<string, unknown> {
  return {
    schema: "openscout.repo.response/v1",
    operation,
    generatedAt: Date.now(),
    value,
    error: null,
    daemonVersion: "test-daemon",
  };
}
