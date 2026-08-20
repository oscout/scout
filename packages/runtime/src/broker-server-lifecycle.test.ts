import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  closeServer,
  isAddressInUse,
  listenTcp,
  listenUnixSocket,
  prepareBrokerSocketPath,
} from "./broker-server-lifecycle.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "openscout-broker-lifecycle-"));
}

describe("broker server lifecycle", () => {
  test("detects address-in-use errors conservatively", () => {
    expect(isAddressInUse({ code: "EADDRINUSE" })).toBe(true);
    expect(isAddressInUse({ code: "ECONNREFUSED" })).toBe(false);
    expect(isAddressInUse(new Error("EADDRINUSE"))).toBe(false);
    expect(isAddressInUse(null)).toBe(false);
  });

  test("prepares socket directories and rejects non-socket paths", async () => {
    const root = await tempDir();
    const socketPath = join(root, "nested", "broker.sock");
    const filePath = join(root, "nested", "not-a-socket");
    try {
      await prepareBrokerSocketPath(socketPath);
      await expect(stat(join(root, "nested"))).resolves.toBeTruthy();

      await writeFile(filePath, "not a socket");
      await expect(prepareBrokerSocketPath(filePath))
        .rejects.toThrow(`broker socket path exists but is not a socket: ${filePath}`);
      await expect(readFile(filePath, "utf8")).resolves.toBe("not a socket");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listens on TCP and closes listening servers", async () => {
    const server = createServer((_request, response) => {
      response.end("ok");
    });

    await listenTcp(server, { host: "127.0.0.1", port: 0 });
    expect(server.listening).toBe(true);

    await closeServer(server, 100);
    expect(server.listening).toBe(false);
  });

  test("listens on Unix sockets after preparing the socket path", async () => {
    const root = await tempDir();
    const socketPath = join(root, "nested", "broker.sock");
    const server = createServer((_request, response) => {
      response.end("ok");
    });
    try {
      await listenUnixSocket(server, socketPath);
      expect(server.listening).toBe(true);
    } finally {
      await closeServer(server, 100);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closeServer resolves immediately for non-listening servers", async () => {
    const server = createServer();
    await expect(closeServer(server, 100)).resolves.toBeUndefined();
  });
});
