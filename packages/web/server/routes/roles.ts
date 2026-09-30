import type { Hono } from "hono";
import { SCOUT_ROLE_CATALOG } from "@openscout/protocol";
import {
  webAppendMissionLog,
  webAssignRole,
  webListMissionLog,
  webListRoleAssignments,
  webRevokeRole,
} from "../db/assigned-roles.ts";
import { parseOptionalPositiveInt } from "../http-helpers.ts";
import { missionLogEntryBody, roleAssignmentBody, roleRevokeBody } from "../../shared/api/roles.ts";
import { readJsonBody } from "../request-body.ts";

export function mountRoleRoutes(app: Hono) {
  // Assigned roles + mission log — proxy to broker (canonical writer).
  app.get("/api/roles/catalog", (c) => c.json({ roles: SCOUT_ROLE_CATALOG }));
  app.get("/api/roles/assignments", async (c) => {
    try {
      const assignments = await webListRoleAssignments({
        agentId: c.req.query("agentId") || undefined,
        missionId: c.req.query("missionId") || undefined,
        roleId: c.req.query("roleId") || undefined,
        activeOnly: c.req.query("activeOnly") !== "0" && c.req.query("activeOnly") !== "false",
        includeStanding: c.req.query("includeStanding") !== "0",
        limit: parseOptionalPositiveInt(c.req.query("limit")),
      });
      return c.json({ assignments });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  app.post("/api/roles/assignments", async (c) => {
    try {
      const parsed = await readJsonBody(c, roleAssignmentBody);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      if (!body.roleId?.trim() || !body.agentId?.trim()) {
        return c.json({ error: "roleId and agentId are required" }, 400);
      }
      const kind = (body.scope?.kind ?? "agent").trim();
      let scope: { kind: "mission"; missionId: string } | { kind: "agent" } | { kind: "project"; projectRoot: string };
      if (kind === "mission") {
        if (!body.scope?.missionId?.trim()) {
          return c.json({ error: "scope.missionId is required for mission scope" }, 400);
        }
        scope = { kind: "mission", missionId: body.scope.missionId.trim() };
      } else if (kind === "project") {
        if (!body.scope?.projectRoot?.trim()) {
          return c.json({ error: "scope.projectRoot is required for project scope" }, 400);
        }
        scope = { kind: "project", projectRoot: body.scope.projectRoot.trim() };
      } else if (kind === "agent") {
        scope = { kind: "agent" };
      } else {
        return c.json({ error: `unknown scope.kind: ${kind}` }, 400);
      }
      const assignment = await webAssignRole({
        roleId: body.roleId.trim(),
        agentId: body.agentId.trim(),
        scope,
        assignedById: body.assignedById?.trim() || "operator",
        enforceSingleOrchestrator: body.enforceSingleOrchestrator,
        metadata: body.metadata,
      });
      return c.json({ assignment }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /unknown role|already has orchestrator|required|unknown scope/i.test(message) ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });
  app.post("/api/roles/assignments/:id/revoke", async (c) => {
    try {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "id is required" }, 400);
      const parsed = await readJsonBody(c, roleRevokeBody);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      const assignment = await webRevokeRole({
        assignmentId: id,
        revokedById: body.revokedById?.trim() || "operator",
      });
      return c.json({ assignment });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /unknown role assignment/i.test(message) ? 404 : 500;
      return c.json({ error: message }, status);
    }
  });
  app.get("/api/missions/:missionId/log", async (c) => {
    try {
      const missionId = c.req.param("missionId");
      if (!missionId) return c.json({ error: "missionId is required" }, 400);
      const afterSeq = parseOptionalPositiveInt(c.req.query("afterSeq"));
      const entries = await webListMissionLog({
        missionId,
        limit: parseOptionalPositiveInt(c.req.query("limit")),
        afterSeq: afterSeq ?? undefined,
      });
      return c.json({ missionId, entries });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  app.post("/api/missions/:missionId/log", async (c) => {
    try {
      const missionId = c.req.param("missionId");
      if (!missionId) return c.json({ error: "missionId is required" }, 400);
      const parsed = await readJsonBody(c, missionLogEntryBody);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      if (!body.actorId?.trim() || !body.kind || !body.intent?.trim() || !body.status?.trim()) {
        return c.json({ error: "actorId, kind, intent, and status are required" }, 400);
      }
      // Client bypassPermission is intentionally ignored; projectRoot is
      // required for project-scoped orchestrator permission matching.
      const entry = await webAppendMissionLog(
        {
          missionId,
          actorId: body.actorId.trim(),
          kind: body.kind as import("@openscout/protocol").ScoutMissionLogKind,
          intent: body.intent,
          status: body.status,
          checkpoint: body.checkpoint,
          nodeId: body.nodeId,
          note: body.note,
          blockers: body.blockers,
          refs: body.refs,
        },
        { projectRoot: body.projectRoot?.trim() || undefined },
      );
      return c.json({ entry }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not an assigned|invalid mission log|unknown/i.test(message) ? 400 : 500;
      return c.json({ error: message }, status);
    }
  });
}
