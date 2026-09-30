import type { Hono } from "hono";
import {
  annotateMachine,
  forgetMachine,
  loadMachine,
  loadMachines,
  runMachineScan,
} from "../core/machines/service.ts";
import {
  announceMeshVisibility,
  controlTailscale,
  joinMesh,
  leaveMesh,
  loadMeshStatus,
} from "../core/mesh/service.ts";
import { machineAnnotationBody, tailnetProbeBody, tailscaleControlBody } from "../../shared/api/mesh.ts";
import { readJsonBody } from "../request-body.ts";
import type { MeshNodeStateStore } from "../core/mesh/node-state.ts";

export type MeshRouteDeps = {
  meshNodeStateStore: MeshNodeStateStore;
};

export function mountMeshRoutes(app: Hono, deps: MeshRouteDeps) {
  const { meshNodeStateStore } = deps;

  // ── Machines (docs/eng/sco-104-machines.md) ──────────────────────────
  // Every handler forwards to the broker, which owns the scan and the durable
  // roster. `?refresh=1` and /scan are the only paths that make probes run.
  app.get("/api/machines", async (c) => {
    try {
      const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
      return c.json(await loadMachines({ refresh }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/machines/scan", async (c) => {
    try {
      return c.json(await runMachineScan());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.get("/api/machines/:reference", async (c) => {
    try {
      return c.json(await loadMachine(c.req.param("reference")));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.patch("/api/machines/:reference", async (c) => {
    try {
      const parsed = await readJsonBody(c, machineAnnotationBody);
      if (!parsed.ok) return parsed.response;
      return c.json(await annotateMachine(c.req.param("reference"), parsed.body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.delete("/api/machines/:reference", async (c) => {
    try {
      return c.json(await forgetMachine(c.req.param("reference")));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.get("/api/mesh", async (c) => {
    try {
      return c.json(await loadMeshStatus());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/announce", async (c) => {
    try {
      return c.json(await announceMeshVisibility());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/join", async (c) => {
    try {
      return c.json(await joinMesh());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/leave", async (c) => {
    try {
      return c.json(await leaveMesh());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.post("/api/mesh/tailscale", async (c) => {
    try {
      const parsed = await readJsonBody(c, tailscaleControlBody);
      if (!parsed.ok) return parsed.response;
      return c.json(await controlTailscale(parsed.body.action));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Per-node state for the Network page. Machines are named by the id the mesh
  // snapshot already publishes, never by URL, and every peer read goes over the
  // signed/pinned mesh client to an observe-tier route.
  app.get("/api/mesh/nodes/state", async (c) => {
    try {
      return c.json(await meshNodeStateStore.list());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Selection read. `deep=1` allows the selection-only fallback for peers that
  // predate compact node state; the recurring list refresh never uses it.
  app.get("/api/mesh/nodes/:machineId/state", async (c) => {
    const machineId = c.req.param("machineId")?.trim();
    if (!machineId) return c.json({ error: "machineId is required" }, 400);
    try {
      const view = await meshNodeStateStore.read(machineId, {
        deep: c.req.query("deep") === "1",
        force: c.req.query("force") === "1",
      });
      if (!view) return c.json({ error: "unknown machine" }, 404);
      return c.json(view);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Manual per-node refresh: bypasses freshness and backoff for this machine
  // only, because the operator asking is itself the evidence worth retrying on.
  app.post("/api/mesh/nodes/:machineId/refresh", async (c) => {
    const machineId = c.req.param("machineId")?.trim();
    if (!machineId) return c.json({ error: "machineId is required" }, 400);
    try {
      const view = await meshNodeStateStore.read(machineId, { deep: true, force: true });
      if (!view) return c.json({ error: "unknown machine" }, 404);
      return c.json(view);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/mesh/tailnet-probe", async (c) => {
    try {
      const parsed = await readJsonBody(c, tailnetProbeBody);
      if (!parsed.ok) return parsed.response;
      const { ip } = parsed.body;
      // Only allow Tailscale CGNAT range (100.64.0.0/10)
      const parts = ip.split(".");
      const oct1 = Number(parts[0]);
      const oct2 = Number(parts[1]);
      if (parts.length !== 4 || oct1 !== 100 || oct2 < 64 || oct2 > 127) {
        return c.json({ error: "IP is not in the Tailscale address range" }, 403);
      }

      const brokerUrl = `http://${ip}:43110`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      try {
        const [homeRes, nodeRes] = await Promise.all([
          fetch(`${brokerUrl}/v1/home`, { signal: ac.signal }),
          fetch(`${brokerUrl}/v1/node`, { signal: ac.signal }),
        ]);
        clearTimeout(timer);
        const home = homeRes.ok ? await homeRes.json() : null;
        const node = nodeRes.ok ? await nodeRes.json() : null;
        return c.json({ reachable: true, home, node });
      } catch (fetchErr) {
        clearTimeout(timer);
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        return c.json({ reachable: false, error: msg });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
}
