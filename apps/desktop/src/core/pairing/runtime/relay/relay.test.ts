import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";

import { startRelay, type RelayOptions } from "./relay.ts";

const activeRelays: Array<{ stop: () => void }> = [];
const activeSockets: WebSocket[] = [];

interface RelayEnvelope {
  phase: "relay";
  event: "message" | "close";
  clientId: string;
  payload?: string;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a free port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.once("error", reject);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket open."));
    }, 5_000);

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("WebSocket failed before open."));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
  });
}

function waitForMessage<T = string>(
  socket: WebSocket,
  decode: (event: MessageEvent) => T = (event) => (typeof event.data === "string" ? event.data : String(event.data)) as T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message."));
    }, 5_000);

    const handleMessage = (event: MessageEvent) => {
      cleanup();
      resolve(decode(event));
    };

    const handleClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before message arrived."));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
    };

    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose);
  });
}

function waitForNoMessage(socket: WebSocket, durationMs = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleMessage = () => {
      cleanup();
      reject(new Error("Unexpected websocket message."));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);

    socket.addEventListener("message", handleMessage);
  });
}

afterEach(() => {
  while (activeSockets.length > 0) {
    const socket = activeSockets.pop();
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }
  }

  while (activeRelays.length > 0) {
    activeRelays.pop()?.stop();
  }
});

test("relay routes distinct client envelopes to and from the bridge", async () => {
  const port = await getFreePort();
  const relay = startRelay(port, {} satisfies RelayOptions);
  activeRelays.push(relay);

  const room = `room-${Date.now()}`;
  const bridge = new WebSocket(`ws://127.0.0.1:${port}?room=${room}&role=bridge&key=bridge-key`);
  const clientA = new WebSocket(`ws://127.0.0.1:${port}?room=${room}&role=client`);
  const clientB = new WebSocket(`ws://127.0.0.1:${port}?room=${room}&role=client`);
  activeSockets.push(bridge, clientA, clientB);

  await Promise.all([waitForOpen(bridge), waitForOpen(clientA), waitForOpen(clientB)]);

  const envelopeA = waitForMessage<RelayEnvelope>(bridge, (event) => JSON.parse(String(event.data)));
  clientA.send("from-a");
  const receivedA = await envelopeA;
  expect(receivedA.phase).toBe("relay");
  expect(receivedA.event).toBe("message");
  expect(receivedA.payload).toBe("from-a");

  const envelopeB = waitForMessage<RelayEnvelope>(bridge, (event) => JSON.parse(String(event.data)));
  clientB.send("from-b");
  const receivedB = await envelopeB;
  expect(receivedB.phase).toBe("relay");
  expect(receivedB.event).toBe("message");
  expect(receivedB.payload).toBe("from-b");
  expect(receivedB.clientId).not.toBe(receivedA.clientId);

  const clientAMessage = waitForMessage(clientA);
  const clientBQuiet = waitForNoMessage(clientB);
  bridge.send(JSON.stringify({
    phase: "relay",
    event: "message",
    clientId: receivedA.clientId,
    payload: "to-a",
  } satisfies RelayEnvelope));
  expect(await clientAMessage).toBe("to-a");
  await clientBQuiet;

  const clientBMessage = waitForMessage(clientB);
  const clientAQuiet = waitForNoMessage(clientA);
  bridge.send(JSON.stringify({
    phase: "relay",
    event: "message",
    clientId: receivedB.clientId,
    payload: "to-b",
  } satisfies RelayEnvelope));
  expect(await clientBMessage).toBe("to-b");
  await clientAQuiet;
});
