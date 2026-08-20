import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  OPENSCOUT_IROH_MESH_ALPN,
  OPENSCOUT_MESH_PROTOCOL_VERSION,
} from "@openscout/protocol";

import {
  resolveIrohMeshEntrypointFromEnv,
  startIrohBridgeServe,
  type IrohBridgeService,
} from "./iroh-bridge.js";

const tempDirs: string[] = [];
const services: IrohBridgeService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.stop();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openscout-iroh-bridge-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("iroh bridge helpers", () => {
  test("resolves a local Iroh mesh entrypoint from environment JSON", () => {
    const entrypoint = resolveIrohMeshEntrypointFromEnv({
      OPENSCOUT_IROH_ENDPOINT_ADDR_JSON: JSON.stringify({ id: "endpoint-from-json", addrs: [] }),
    });

    expect(entrypoint).toMatchObject({
      kind: "iroh",
      endpointId: "endpoint-from-json",
      alpn: OPENSCOUT_IROH_MESH_ALPN,
      bridgeProtocolVersion: OPENSCOUT_MESH_PROTOCOL_VERSION,
    });
  });

  test("starts a bridge process and reads its advertised endpoint", async () => {
    const dir = await makeTempDir();
    const scriptPath = join(dir, "fake-bridge.sh");
    await Bun.write(scriptPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"bridgeProtocolVersion\":1,\"alpn\":\"openscout/mesh/0\",\"endpointId\":\"fake-endpoint\",\"endpointAddr\":{\"id\":\"fake-endpoint\",\"addrs\":[]},\"identityPath\":\"/tmp/fake.key\"}'",
      "sleep 30",
      "",
    ].join("\n"));
    await chmod(scriptPath, 0o755);

    const service = await startIrohBridgeServe({
      bridgeBin: scriptPath,
      identityPath: join(dir, "iroh.key"),
      brokerUrl: "http://127.0.0.1:65501",
      startupTimeoutMs: 1_000,
      onlineTimeoutMs: 100,
    });
    services.push(service);

    expect(service.entrypoint.endpointId).toBe("fake-endpoint");
    expect(service.entrypoint.endpointAddr).toEqual({ id: "fake-endpoint", addrs: [] });
  });
});
