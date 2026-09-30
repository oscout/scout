import { afterEach, expect, test } from "bun:test";
import { tailscaleStatusProbe } from "@openscout/runtime/system-probes";
import { loadMeshStatus } from "./service.ts";

const originalFetch = globalThis.fetch;
const originalRead = tailscaleStatusProbe.read;
const originalNow = Date.now;
const originalUrl = process.env.OPENSCOUT_BROKER_INTERNAL_URL;
const originalSocket = process.env.OPENSCOUT_BROKER_SOCKET_PATH;

afterEach(() => {
  globalThis.fetch = originalFetch;
  tailscaleStatusProbe.read = originalRead;
  Date.now = originalNow;
  if (originalUrl === undefined) delete process.env.OPENSCOUT_BROKER_INTERNAL_URL;
  else process.env.OPENSCOUT_BROKER_INTERNAL_URL = originalUrl;
  if (originalSocket === undefined) delete process.env.OPENSCOUT_BROKER_SOCKET_PATH;
  else process.env.OPENSCOUT_BROKER_SOCKET_PATH = originalSocket;
});

test("mesh returns useful partial status while the snapshot stalls, then reports recovery and degradation", async () => {
  process.env.OPENSCOUT_BROKER_INTERNAL_URL = "http://mesh-status.test";
  process.env.OPENSCOUT_BROKER_SOCKET_PATH = "/nonexistent/mesh-status-test.sock";
  let now = 100_000;
  Date.now = () => now;
  let degraded = false;
  let releaseSnapshot!: (response: Response) => void;
  const pendingSnapshot = new Promise<Response>((resolve) => { releaseSnapshot = resolve; });
  tailscaleStatusProbe.read = () => ({
    id: "tailscale.status", value: { running: false, backendState: "Stopped", health: [], peers: [], self: null },
    at: 50_000, ageMs: now - 50_000, stale: true, refreshing: true, status: "stale",
    error: { code: "timeout", message: "Tailscale probe timed out", at: now }, consecutiveFailures: 1, backend: "local",
  });
  globalThis.fetch = (async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/health") return Response.json(degraded ? { error: "warming" } : { ok: true, nodeId: "local", meshId: "mesh" }, { status: degraded ? 503 : 200 });
    if (path === "/v1/node") return Response.json({ id: "local", meshId: "mesh", advertiseScope: "local" });
    return pendingSnapshot;
  }) as typeof fetch;

  const partial = await loadMeshStatus();
  expect(partial.health.ok).toBe(true);
  expect(partial.partial).toBe(true);
  expect(partial.localNode).toBeNull();
  expect(partial.identity.modeLabel).toBe("Node status pending");
  expect(partial.issues.map((issue) => issue.code)).toContain("broker_snapshot_unavailable");
  expect(partial.issues.map((issue) => issue.code)).not.toContain("tailscale_stopped");
  expect(partial.tailscale.freshness).toMatchObject({ lastSuccessAt: 50_000, stale: true, error: "Tailscale probe timed out" });

  releaseSnapshot(Response.json({ nodes: {}, messages: {} }));
  await Bun.sleep(0);
  now += 16_000;
  const recovered = await loadMeshStatus();
  expect(recovered.localNode?.id).toBe("local");
  expect(recovered.snapshotFreshness).toMatchObject({ lastSuccessAt: 100_000, stale: false });

  degraded = true;
  now += 16_000;
  const failed = await loadMeshStatus();
  expect(failed.health).toMatchObject({ reachable: true, ok: false, observation: { state: "degraded", lastSuccessAt: 116_000 } });
  expect(failed.localNode?.id).toBe("local");
  expect(failed.snapshotFreshness?.stale).toBe(true);
  expect(failed.identity.discoverable).toBe(false);
  expect(failed.identity.modeLabel).toBe("Broker degraded");
  expect(failed.partial).toBe(true);
  await Bun.sleep(0);
});
