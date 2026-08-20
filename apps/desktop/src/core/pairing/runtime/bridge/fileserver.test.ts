import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import type { SessionState } from "@openscout/agent-sessions";

import {
  isTrustedLoopbackPeerAddress,
  startFileServer,
  type FileServer,
} from "./fileserver.ts";
import {
  pairingFileServerOrigin,
  readPairingAttachmentBlob,
  storePairingAttachmentBlob,
} from "./fileserver.ts";
import { issueWebHandoff } from "./web-handoff.ts";

const activeServers: FileServer[] = [];
const temporaryFiles: string[] = [];

/** The blob and its metadata sidecar, as `storePairingAttachmentBlob` writes them. */
function attachmentPaths(id: string): [string, string] {
  const root = join(homedir(), ".scout", "pairing", "attachments");
  return [join(root, id), join(root, `${id}.json`)];
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

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.once("error", reject);
  });
}

afterEach(async () => {
  while (activeServers.length > 0) {
    activeServers.pop()?.stop();
  }

  while (temporaryFiles.length > 0) {
    const filePath = temporaryFiles.pop();
    if (filePath) {
      await rm(filePath, { force: true });
    }
  }
});

test("pairing file server exposes health and allowed file reads", async () => {
  const port = await getFreePort();
  const server = startFileServer({ port });
  activeServers.push(server);

  const filePath = join("/tmp", `scout-fileserver-${Date.now()}.txt`);
  temporaryFiles.push(filePath);
  await writeFile(filePath, "hello from scout\n", "utf8");

  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.json()).toEqual({ ok: true });

  const fileResponse = await fetch(
    `http://127.0.0.1:${port}/file?path=${encodeURIComponent(filePath)}`,
  );
  expect(fileResponse.status).toBe(200);
  expect(await fileResponse.text()).toBe("hello from scout\n");
});

test("local file authorization trusts the socket peer, not a spoofed localhost Host", async () => {
  const port = await getFreePort();
  const observed: { hostname: string | null } = { hostname: null };
  const server = startFileServer({
    port,
    resolvePeerAddress(req) {
      observed.hostname = new URL(req.url).hostname;
      return "192.168.1.50";
    },
  });
  activeServers.push(server);

  const filePath = join("/tmp", `scout-fileserver-remote-${Date.now()}.txt`);
  temporaryFiles.push(filePath);
  await writeFile(filePath, "private host file\n", "utf8");

  const response = await fetch(
    `http://127.0.0.1:${port}/file?path=${encodeURIComponent(filePath)}`,
    { headers: { host: `localhost:${port}` } },
  );

  expect(observed.hostname).toBe("localhost");
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("Forbidden");
});

test("local file authorization rejects DNS rebinding and cross-origin browser requests", async () => {
  const port = await getFreePort();
  const server = startFileServer({
    port,
    resolvePeerAddress: () => "127.0.0.1",
  });
  activeServers.push(server);

  const filePath = join("/tmp", `scout-fileserver-origin-${Date.now()}.txt`);
  temporaryFiles.push(filePath);
  await writeFile(filePath, "same-origin only\n", "utf8");
  const url = `http://127.0.0.1:${port}/file?path=${encodeURIComponent(filePath)}`;

  const rebound = await fetch(url, {
    headers: {
      host: `attacker.example:${port}`,
      origin: `http://attacker.example:${port}`,
      "sec-fetch-site": "same-origin",
    },
  });
  expect(rebound.status).toBe(403);

  const crossOrigin = await fetch(url, {
    headers: {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  expect(crossOrigin.status).toBe(403);

  const sameOrigin = await fetch(url, {
    headers: {
      origin: `http://127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin",
    },
  });
  expect(sameOrigin.status).toBe(200);
  expect(await sameOrigin.text()).toBe("same-origin only\n");
});

test("local file authorization normalizes IPv4 and IPv6 loopback peers", () => {
  for (const address of [
    "127.0.0.1",
    "127.42.0.9",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "[::1]",
  ]) {
    expect(isTrustedLoopbackPeerAddress(address)).toBe(true);
  }

  for (const address of [undefined, "localhost", "128.0.0.1", "192.168.1.50", "::2"] as const) {
    expect(isTrustedLoopbackPeerAddress(address)).toBe(false);
  }
});

test("local file reads resolve symlinks and stay inside canonical allowed roots", async () => {
  const port = await getFreePort();
  const server = startFileServer({ port });
  activeServers.push(server);

  const suffix = randomUUID();
  const targetPath = join("/tmp", `scout-fileserver-target-${suffix}.txt`);
  const insideLink = join("/tmp", `scout-fileserver-inside-${suffix}.txt`);
  const escapeLink = join("/tmp", `scout-fileserver-escape-${suffix}.txt`);
  temporaryFiles.push(targetPath, insideLink, escapeLink);
  await writeFile(targetPath, "allowed symlink target\n", "utf8");
  await symlink(targetPath, insideLink);
  await symlink("/etc/hosts", escapeLink);

  const inside = await fetch(
    `http://127.0.0.1:${port}/file?path=${encodeURIComponent(insideLink)}`,
  );
  expect(inside.status).toBe(200);
  expect(await inside.text()).toBe("allowed symlink target\n");

  const escaped = await fetch(
    `http://127.0.0.1:${port}/file?path=${encodeURIComponent(escapeLink)}`,
  );
  expect(escaped.status).toBe(403);
});

test("pairing file server hosts uploaded opaque attachments", async () => {
  const port = await getFreePort();
  const server = startFileServer({ port });
  activeServers.push(server);

  const uploaded = storePairingAttachmentBlob(
    {
      data: Buffer.from("hello attachment\n", "utf8").toString("base64"),
      mediaType: "text/plain",
      fileName: "hello.txt",
    },
    { origin: pairingFileServerOrigin(port) },
  );

  const response = await fetch(uploaded.url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain");
  expect(response.headers.get("content-disposition")).toContain("hello.txt");
  expect(await response.text()).toBe("hello attachment\n");
});

test("hosted attachments read back as bytes for a client that can't follow the URL", async () => {
  const uploaded = storePairingAttachmentBlob(
    {
      data: Buffer.from("bytes over the bridge\n", "utf8").toString("base64"),
      mediaType: "image/png",
      fileName: "shot.png",
    },
    { origin: pairingFileServerOrigin(1) },
  );
  temporaryFiles.push(...attachmentPaths(uploaded.id));

  const blob = readPairingAttachmentBlob(uploaded.id);
  expect(blob).not.toBeNull();
  expect(blob?.mediaType).toBe("image/png");
  expect(blob?.fileName).toBe("shot.png");
  expect(Buffer.from(blob!.data, "base64").toString("utf8")).toBe("bytes over the bridge\n");

  expect(readPairingAttachmentBlob(uploaded.id, uploaded.expiresAt + 1)).toBeNull();
  expect(readPairingAttachmentBlob("att-does-not-exist")).toBeNull();
  expect(readPairingAttachmentBlob("../../../etc/passwd")).toBeNull();
});

test("an attachment left by a previous broker process is rebuilt from its sidecar", async () => {
  // What a restart leaves behind: bytes and metadata on disk, nothing in the
  // in-memory index. The id in the already-sent message has to keep working.
  const id = `att-${randomUUID()}`;
  const [blobPath, sidecarPath] = attachmentPaths(id);
  temporaryFiles.push(blobPath, sidecarPath);
  await mkdir(join(homedir(), ".scout", "pairing", "attachments"), { recursive: true });
  await writeFile(blobPath, "restarted\n", "utf8");
  const expiresAt = Date.now() + 60_000;
  await writeFile(
    sidecarPath,
    JSON.stringify({ id, mediaType: "image/jpeg", fileName: "old.jpg", size: 10, expiresAt }),
    "utf8",
  );

  const blob = readPairingAttachmentBlob(id);
  expect(blob?.mediaType).toBe("image/jpeg");
  expect(Buffer.from(blob!.data, "base64").toString("utf8")).toBe("restarted\n");

  // Expiry still applies to the rebuilt entry.
  expect(readPairingAttachmentBlob(id, expiresAt + 1)).toBeNull();
});

test("pairing file server requires a scoped secure token for web handoffs", async () => {
  const port = await getFreePort();
  const snapshot: SessionState = {
    session: {
      id: "session-1",
      name: "Secure Session",
      adapterType: "claude-code",
      status: "active",
      cwd: "/tmp/demo",
    },
    turns: [{
      id: "turn-1",
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
      blocks: [{
        status: "completed",
        block: {
          id: "block-1",
          turnId: "turn-1",
          type: "action",
          status: "completed",
          index: 0,
          action: {
            kind: "file_change",
            status: "completed",
            path: "src/demo.ts",
            diff: "+hello\n-world",
            output: "",
          },
        },
      }],
    }],
  };
  const server = startFileServer({
    port,
    bridge: {
      getSessionSnapshot(sessionId: string) {
        return sessionId === "session-1" ? snapshot : null;
      },
    },
  });
  activeServers.push(server);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/handoff/session/session-1`);
  expect(unauthorized.status).toBe(401);

  const handoff = issueWebHandoff({ kind: "session", sessionId: "session-1" }, "device-1");
  const authorized = await fetch(`http://127.0.0.1:${port}/handoff/session/session-1`, {
    headers: {
      "x-scout-handoff-token": handoff.token,
    },
  });
  expect(authorized.status).toBe(200);
  const body = await authorized.text();
  expect(body).toContain("Secure Proxy Session Handoff");
  expect(body).toContain("Secure Session");

  const scopedMiss = await fetch(`http://127.0.0.1:${port}/handoff/file-change/session-1/turn-1/block-1`, {
    headers: {
      "x-scout-handoff-token": handoff.token,
    },
  });
  expect(scopedMiss.status).toBe(401);
});
