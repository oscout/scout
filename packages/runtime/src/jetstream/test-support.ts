import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveJetStreamConfig, type JetStreamRuntimeConfig } from "./config.js";
import { NatsJetStreamSidecar, resolveNatsServerBinary } from "./sidecar.js";

/**
 * Test-only scaffolding for real-NATS integration tests.
 *
 * Every harness here is isolated by construction: its own free port, its own
 * temp store directory, its own progress file. Nothing touches the operator's
 * installed nats-server, `~/Library/Application Support/OpenScout`, or the
 * ports in `OPENSCOUT_PORTS`.
 */
export function hasNatsServerBinary(binary = process.env.OPENSCOUT_JETSTREAM_BINARY || "nats-server"): boolean {
  return resolveNatsServerBinary(binary) !== null;
}

export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close(() => reject(new Error("could not reserve a loopback port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Last-resort reaper for servers this test process spawned.
 *
 * `detached: false` does not make a child die with its parent on POSIX, so a
 * timed-out or aborted test runner leaves nats-server reparented to init, still
 * holding a port and a temp store. This kills only live child handles spawned here, only on
 * the way out — the same ownership rule the production sidecar follows, which
 * is why it lives in test support and not in the sidecar itself.
 */
const spawnedServers = new Set<ChildProcess>();
let reaperInstalled = false;

function trackSpawnedServer(child: ChildProcess): void {
  spawnedServers.add(child);
  child.once("exit", () => spawnedServers.delete(child));
  child.once("error", () => spawnedServers.delete(child));
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = (): void => {
    for (const child of spawnedServers) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    spawnedServers.clear();
  };
  process.once("exit", reap);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      reap();
      process.exit(1);
    });
  }
}

export type IsolatedJetStreamHarness = {
  config: JetStreamRuntimeConfig;
  sidecar: NatsJetStreamSidecar;
  root: string;
  /** Stop the server and delete every file this harness created. */
  dispose(): Promise<void>;
  /** Stop the server without deleting state, for restart/outage tests. */
  stopServer(): Promise<void>;
  startServer(): Promise<void>;
};

export async function createIsolatedJetStreamHarness(
  overrides: Partial<JetStreamRuntimeConfig> = {},
): Promise<IsolatedJetStreamHarness> {
  const root = mkdtempSync(join(tmpdir(), "openscout-jetstream-"));
  const [port, monitorPort] = await Promise.all([reserveLoopbackPort(), reserveLoopbackPort()]);
  const config = resolveJetStreamConfig(
    { OPENSCOUT_JETSTREAM_HOME: root } as NodeJS.ProcessEnv,
    {
      serverBinary: process.env.OPENSCOUT_JETSTREAM_BINARY || "nats-server",
      enabled: true,
      manageServer: true,
      host: "127.0.0.1",
      port,
      monitorPort,
      storeDirectory: join(root, "store"),
      progressPath: join(root, "publisher-progress.json"),
      logPath: join(root, "nats-server.log"),
      pidPath: join(root, "nats-server.pid"),
      streamName: `SCOUT_TEST_${port}`,
      // Tight loops in tests: checkpoint often, keep the dedupe window wider.
      checkpointIntervalMs: 1_000,
      duplicateWindowMs: 120_000,
      readyTimeoutMs: 20_000,
      connectTimeoutMs: 2_000,
      maxReconnectAttempts: 3,
      reconnectTimeWaitMs: 100,
      publishTimeoutMs: 1_500,
      publishMaxAttempts: 2,
      ...overrides,
    },
  );
  // Track the actual child at spawn, including automatic respawns, and drop
  // the handle on exit. A cached numeric pid could later name another process.
  const makeSidecar = () => new NatsJetStreamSidecar({
    config,
    spawnProcess: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      trackSpawnedServer(child);
      return child;
    }) as typeof spawn,
  });
  let sidecar = makeSidecar();
  try {
    await sidecar.start();
  } catch (error) {
    await sidecar.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    config,
    get sidecar() {
      return sidecar;
    },
    root,
    stopServer: async () => {
      await sidecar.stop();
    },
    startServer: async () => {
      sidecar = makeSidecar();
      await sidecar.start();
    },
    dispose: async () => {
      await sidecar.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
