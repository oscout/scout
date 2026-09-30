import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

import { connectMeshBridge, revokeMeshBridgeCredential } from "./mesh-bridge-connect.ts";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Stands in for the browser and the gateway: approve by hitting the loopback
// callback, then check the exchange carries the verifier for the challenge.
function fakeGateway(options: { decision: "approve" | "deny"; wrongState?: boolean }) {
  let challenge = "";
  let redirectUri = "";
  const opened: string[] = [];
  return {
    opened,
    openUrl: async (value: string) => {
      opened.push(value);
      const url = new URL(value);
      challenge = url.searchParams.get("code_challenge")!;
      redirectUri = url.searchParams.get("redirect_uri")!;
      const callback = new URL(redirectUri);
      if (options.wrongState) {
        callback.searchParams.set("state", "someone-else");
        callback.searchParams.set("code", "stray");
        expect((await fetch(callback)).status).toBe(400);
        return;
      }
      callback.searchParams.set("state", url.searchParams.get("state")!);
      if (options.decision === "approve") callback.searchParams.set("code", "c".repeat(48));
      else callback.searchParams.set("error", "access_denied");
      await fetch(callback);
    },
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string; redirect_uri: string };
      expect(String(input)).toBe("https://mcp.example/v1/mcp/bridge/token");
      const matches = base64Url(createHash("sha256").update(body.code_verifier).digest()) === challenge
        && body.redirect_uri === redirectUri
        && body.code === "c".repeat(48);
      return matches
        ? Response.json({ credential: `osbr_${"f".repeat(64)}`, id: "cred-1", node: "default", account: "someone" }, { status: 201 })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as typeof fetch,
  };
}

test("connect trades the loopback code and verifier for a bridge credential", async () => {
  const gateway = fakeGateway({ decision: "approve" });
  const result = await connectMeshBridge({
    relayUrl: "https://mcp.example",
    node: "default",
    label: "Studio Mac",
    openUrl: gateway.openUrl,
    fetch: gateway.fetch,
  });
  expect(result).toEqual({ credential: `osbr_${"f".repeat(64)}`, credentialId: "cred-1", node: "default", account: "someone" });

  const opened = new URL(gateway.opened[0]!);
  expect(opened.origin + opened.pathname).toBe("https://mcp.example/v1/mcp/bridge/connect");
  expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
  expect(opened.searchParams.get("label")).toBe("Studio Mac");
  expect(new URL(opened.searchParams.get("redirect_uri")!).hostname).toBe("127.0.0.1");
});

test("cancelling in the browser fails the connect", async () => {
  const gateway = fakeGateway({ decision: "deny" });
  await expect(connectMeshBridge({
    relayUrl: "https://mcp.example",
    node: "default",
    label: null,
    openUrl: gateway.openUrl,
    fetch: gateway.fetch,
  })).rejects.toThrow("cancelled");
});

test("a callback with someone else's state is ignored", async () => {
  const gateway = fakeGateway({ decision: "approve", wrongState: true });
  await expect(connectMeshBridge({
    relayUrl: "https://mcp.example",
    node: "default",
    label: null,
    openUrl: gateway.openUrl,
    fetch: gateway.fetch,
    timeoutMs: 200,
  })).rejects.toThrow("timed out");
});

test("revoke only touches self-serve credentials", async () => {
  const calls: string[] = [];
  const doFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`);
    return Response.json({ ok: true });
  }) as typeof fetch;
  expect(await revokeMeshBridgeCredential("https://mcp.example", "shared-operator-token", doFetch)).toBe(false);
  expect(await revokeMeshBridgeCredential("https://mcp.example", "osbr_abc", doFetch)).toBe(true);
  expect(calls).toEqual(["DELETE https://mcp.example/v1/mcp/bridge/credential"]);
});
