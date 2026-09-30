import type { Hono } from "hono";
import type { Context } from "hono";
import type { CollaborationEvent, WorkItemRecord } from "@openscout/protocol";
import {
  queryMeshOpsActiveFlightCount,
  queryMeshOpsHosts,
  queryMeshOpsItems,
  queryMeshOpsSessions,
  queryMeshOpsWorkRecord,
} from "../db/mesh-ops.ts";
import { appendScoutCollaborationEvent, upsertScoutCollaborationRecord } from "../core/broker/service.ts";
import { buildScoutEntityId, dismissCollaborationAttention } from "../core/attention/operator-attention-state.ts";

type MeshOpsActuation = "hold" | "release" | "accept" | "clear";

type MeshOpsRecordActuation = Exclude<MeshOpsActuation, "clear">;

/**
 * Build the record mutation + audit event for a Mesh Ops actuation. The
 * caller posts both through the broker (canonical writer): the record via
 * collaboration.upsert, the event via collaboration.event.append (which also
 * fires the SSE collaboration.event.appended).
 *
 *  - hold:    any active state → waiting, waitingOn = "Held by operator",
 *             next move to the operator.
 *  - release: → open (or working while flights are still active), waitingOn
 *             cleared, next move back to the owner.
 *  - accept:  only from review → done + acceptanceState accepted.
 *
 * Clear is an attention dismissal, not a record mutation, and is handled
 * separately by the route so stale dismiss intent can never accept review.
 */
function buildMeshOpsActuation(
  record: WorkItemRecord,
  action: MeshOpsRecordActuation,
  at: number,
): { record: WorkItemRecord; event: CollaborationEvent } {
  const operatorId = "operator";
  const baseEvent = {
    id: buildScoutEntityId("evt", at),
    recordId: record.id,
    recordKind: "work_item" as const,
    actorId: operatorId,
    at,
    metadata: {
      source: "openscout-web",
      surface: "mesh-ops",
    },
  };

  if (action === "hold") {
    return {
      record: {
        ...record,
        state: "waiting",
        waitingOn: { kind: "condition", label: "Held by operator" },
        nextMoveOwnerId: operatorId,
        updatedAt: at,
      },
      event: {
        ...baseEvent,
        kind: "waiting",
        summary: "Held by operator.",
      },
    };
  }

  if (action === "release") {
    const hasActiveFlights = queryMeshOpsActiveFlightCount(record.id) > 0;
    return {
      record: {
        ...record,
        state: hasActiveFlights ? "working" : "open",
        waitingOn: undefined,
        nextMoveOwnerId: record.ownerId ?? record.createdById,
        updatedAt: at,
      },
      event: {
        ...baseEvent,
        kind: "progressed",
        summary: "Released by operator.",
      },
    };
  }

  // Clear is handled as an attention dismissal before this builder. The only
  // remaining terminal transition is the explicit accept intent.
  return {
    record: {
      ...record,
      state: "done",
      acceptanceState: "accepted",
      completedAt: record.completedAt ?? at,
      updatedAt: at,
    },
    event: {
      ...baseEvent,
      kind: "accepted",
      summary: "Accepted by operator.",
    },
  };
}

export function mountMeshOpsRoutes(app: Hono) {
  // Mesh Ops — attention-ordered work items across hosts (local broker only),
  // plus observed runtime sessions inside the seven-day lookback as scan rows.
  app.get("/api/mesh-ops", (c) => {
    const machineId = c.req.query("machineId");
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(rawLimit)
      ? Math.min(250, Math.max(1, Math.floor(rawLimit)))
      : undefined;
    return c.json({
      generatedAt: new Date().toISOString(),
      items: [
        ...queryMeshOpsItems({ machineId: machineId || undefined, limit }),
        ...queryMeshOpsSessions({ machineId: machineId || undefined }),
      ],
      hosts: queryMeshOpsHosts(),
    });
  });
  const handleMeshOpsActuation = (action: MeshOpsActuation) => async (c: Context) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }
    const record = queryMeshOpsWorkRecord(id);
    if (!record) {
      return c.json({ error: "not found" }, 404);
    }
    if (action === "hold" && record.state !== "open" && record.state !== "working") {
      return c.json({ error: `cannot hold a work item in ${record.state}` }, 409);
    }
    if (
      action === "release"
      && (
        record.state !== "waiting"
        || record.nextMoveOwnerId !== "operator"
        || record.waitingOn?.label !== "Held by operator"
      )
    ) {
      return c.json({ error: "only an operator-held work item can be released" }, 409);
    }
    if (action === "accept" && record.state !== "review") {
      return c.json({ error: `cannot accept a work item in ${record.state}` }, 409);
    }
    if (action === "clear" && record.state === "review") {
      return c.json({ error: "a review item must be explicitly accepted" }, 409);
    }
    try {
      if (action === "clear") {
        await dismissCollaborationAttention({
          recordKind: "work_item",
          recordId: record.id,
          itemUpdatedAt: record.updatedAt,
        });
        return c.json({ ok: true, action: "dismissed", record });
      }
      const actuation = buildMeshOpsActuation(record, action, Date.now());
      await upsertScoutCollaborationRecord(actuation.record);
      await appendScoutCollaborationEvent(actuation.event);
      return c.json({
        ok: true,
        action,
        record: actuation.record,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  };
  app.post("/api/mesh-ops/items/:id/hold", handleMeshOpsActuation("hold"));
  app.post("/api/mesh-ops/items/:id/release", handleMeshOpsActuation("release"));
  app.post("/api/mesh-ops/items/:id/accept", handleMeshOpsActuation("accept"));
  app.post("/api/mesh-ops/items/:id/clear", handleMeshOpsActuation("clear"));
}
