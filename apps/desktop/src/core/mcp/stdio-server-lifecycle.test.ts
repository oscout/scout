import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import { waitForStdioServerClosure } from "./stdio-server-lifecycle.ts";

describe("stdio server lifecycle", () => {
  test("closes the transport and resolves when stdin reaches EOF", async () => {
    const stdin = new PassThrough();
    stdin.resume();
    const signals = new EventEmitter() as NodeJS.Process;
    let transportCloseCount = 0;
    let previousCloseCount = 0;
    const transport = {
      onclose: () => {
        previousCloseCount += 1;
      },
      async close() {
        transportCloseCount += 1;
        transport.onclose?.();
      },
    };
    const server = {
      async close() {
        throw new Error("EOF should close the transport directly");
      },
    };

    const lifecycle = waitForStdioServerClosure({
      server,
      transport,
      stdin,
      processSignals: signals,
    });
    expect(transportCloseCount).toBe(0);

    stdin.end();
    await lifecycle;

    expect(transportCloseCount).toBe(1);
    expect(previousCloseCount).toBe(1);
  });

  test("closes the server on termination signals", async () => {
    const stdin = new PassThrough();
    const signals = new EventEmitter() as NodeJS.Process;
    let serverCloseCount = 0;
    const transport: { close(): Promise<void>; onclose?: () => void } = {
      async close() {},
    };
    const server = {
      async close() {
        serverCloseCount += 1;
        transport.onclose?.();
      },
    };

    const lifecycle = waitForStdioServerClosure({
      server,
      transport,
      stdin,
      processSignals: signals,
    });
    signals.emit("SIGTERM");
    await lifecycle;

    expect(serverCloseCount).toBe(1);
  });

  test("lets a termination signal close the server when transport close hangs", async () => {
    const stdin = new PassThrough();
    stdin.resume();
    const signals = new EventEmitter() as NodeJS.Process;
    let serverCloseCount = 0;
    const transport: { close(): Promise<void>; onclose?: () => void } = {
      async close() {
        await new Promise<void>(() => {});
      },
    };
    const server = {
      async close() {
        serverCloseCount += 1;
      },
    };

    const lifecycle = waitForStdioServerClosure({
      server,
      transport,
      stdin,
      processSignals: signals,
    });
    stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    signals.emit("SIGTERM");
    await lifecycle;

    expect(serverCloseCount).toBe(1);
  });
});
