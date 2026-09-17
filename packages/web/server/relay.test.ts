import { afterEach, expect, test } from "bun:test";
import {
  createRelayWebSocketProxy,
  sanitizeUploadName,
  type RelayWSData,
} from "./relay.ts";

test("sanitizeUploadName strips directory traversal and separators", () => {
  // Traversal / absolute paths must not escape the upload dir.
  expect(sanitizeUploadName("../../../../etc/authorized_keys")).toBe("authorized_keys");
  expect(sanitizeUploadName("/etc/passwd")).toBe("passwd");
  expect(sanitizeUploadName("a/b/c.png")).toBe("c.png");
  // Names that reduce to nothing usable are rejected.
  expect(sanitizeUploadName("..")).toBeNull();
  expect(sanitizeUploadName(".")).toBeNull();
  expect(sanitizeUploadName("/")).toBeNull();
  expect(sanitizeUploadName("   ")).toBeNull();
  // Ordinary names pass through.
  expect(sanitizeUploadName("screenshot.png")).toBe("screenshot.png");
});

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

function waitForMessage(url: string, protocol?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for websocket message."));
    }, 2_000);

    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(event.data));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error before message."));
    });
  });
}

test("forwards websocket subprotocols to the upstream socket", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected websocket upgrade", { status: 400 });
      }
      if (req.headers.get("sec-websocket-protocol") !== "vite-hmr") {
        return new Response("Missing vite-hmr subprotocol", { status: 426 });
      }
      return server.upgrade(req)
        ? (undefined as unknown as Response)
        : new Response("WebSocket upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "connected" }));
      },
    },
  });
  servers.push(upstream);

  const proxy = Bun.serve<RelayWSData>({
    port: 0,
    fetch(req, server) {
      return server.upgrade(req, {
        data: {
          upstream: null,
          pending: [],
          upstreamProtocol: req.headers.get("sec-websocket-protocol"),
          upstreamUrl: `ws://127.0.0.1:${upstream.port}/ws/hmr`,
        },
      })
        ? (undefined as unknown as Response)
        : new Response("WebSocket upgrade failed", { status: 500 });
    },
    websocket: createRelayWebSocketProxy(),
  });
  servers.push(proxy);

  await expect(waitForMessage(`ws://127.0.0.1:${proxy.port}/ws/hmr`, "vite-hmr"))
    .resolves.toBe(JSON.stringify({ type: "connected" }));
});

test("sends upstreamHeaders on the upstream websocket handshake", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected websocket upgrade", { status: 400 });
      }
      // A peer doorway bridge must present the doorway name as Host so the
      // peer's trust gate sees its own advertised host, and carry the
      // browser's session cookie for that origin.
      if (req.headers.get("host") !== "studio-mini.scout.local"
        || req.headers.get("cookie") !== "openscout_web=session-cookie"
        || req.headers.get("origin") !== "http://studio-mini.scout.local") {
        return new Response("Doorway headers missing", { status: 403 });
      }
      return server.upgrade(req)
        ? (undefined as unknown as Response)
        : new Response("WebSocket upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws) {
        ws.send("doorway-bridged");
      },
    },
  });
  servers.push(upstream);

  const proxy = Bun.serve<RelayWSData>({
    port: 0,
    fetch(req, server) {
      return server.upgrade(req, {
        data: {
          upstream: null,
          pending: [],
          upstreamProtocol: null,
          upstreamUrl: `ws://127.0.0.1:${upstream.port}/ws/peer`,
          upstreamHeaders: {
            host: "studio-mini.scout.local",
            cookie: "openscout_web=session-cookie",
            origin: "http://studio-mini.scout.local",
          },
        },
      })
        ? (undefined as unknown as Response)
        : new Response("WebSocket upgrade failed", { status: 500 });
    },
    websocket: createRelayWebSocketProxy(),
  });
  servers.push(proxy);

  await expect(waitForMessage(`ws://127.0.0.1:${proxy.port}/ws/peer`))
    .resolves.toBe("doorway-bridged");
});
