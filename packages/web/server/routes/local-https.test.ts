import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ScoutLocalEdgeTrustReport } from "@openscout/runtime/local-edge";

import { mountLocalHttpsRoutes } from "./local-https.ts";

const untrusted: ScoutLocalEdgeTrustReport = {
  status: "untrusted",
  rootCertificatePath: "/fixture/root.crt",
  trustCommand: "security add-trusted-cert",
  detail: "Caddy's local CA root exists, but macOS does not trust it yet.",
};

function app(peer: string, trust: () => Promise<ScoutLocalEdgeTrustReport>) {
  const server = new Hono();
  mountLocalHttpsRoutes(server, {
    options: { resolvePeerAddress: () => peer },
    inspect: () => untrusted,
    trust,
  });
  return server;
}

describe("local https trust routes", () => {
  test("offers the https door and the dialog to a page on this Mac", async () => {
    const response = await app("127.0.0.1", async () => untrusted)
      .request("http://m1.scout.local/api/local-https");
    expect(await response.json()).toEqual({
      status: "untrusted",
      trusted: false,
      detail: untrusted.detail,
      secureOrigin: "https://m1.scout.local",
      canTrustHere: true,
      command: "scout server trust",
    });
  });

  test("a page on another device sees the status but cannot raise the dialog", async () => {
    let asked = 0;
    const server = app("192.168.1.40", async () => { asked++; return untrusted; });
    const state = await (await server.request("http://m1.scout.local/api/local-https")).json();
    expect(state.canTrustHere).toBe(false);
    const response = await server.request("http://m1.scout.local/api/local-https/trust", { method: "POST" });
    expect(response.status).toBe(403);
    expect(asked).toBe(0);
  });

  test("concurrent trust requests share one dialog", async () => {
    let asked = 0;
    let answer!: (report: ScoutLocalEdgeTrustReport) => void;
    const server = app("127.0.0.1", () => {
      asked++;
      return new Promise((resolve) => { answer = resolve; });
    });
    const first = server.request("http://m1.scout.local/api/local-https/trust", { method: "POST" });
    const second = server.request("http://m1.scout.local/api/local-https/trust", { method: "POST" });
    await Promise.resolve();
    answer({ ...untrusted, status: "installed", trustCommand: null, detail: "Trusted." });
    const states = await Promise.all([first, second].map(async (r) => (await r).json()));
    expect(asked).toBe(1);
    expect(states.map((s) => s.trusted)).toEqual([true, true]);
  });

  test("a loopback page has no https door to offer", async () => {
    const state = await (await app("127.0.0.1", async () => untrusted)
      .request("http://127.0.0.1:43120/api/local-https")).json();
    expect(state.secureOrigin).toBeNull();
  });
});
