import type { Hono } from "hono";
import type { Context } from "hono";
import { queryAgents, queryWorkItems, queryWorkItemById } from "../db-queries.ts";
import { buildWorkMaterialsInventory, readWorkMaterialContent, readWorkMaterialRaw } from "../work-materials.ts";
import { indexPlanDocuments } from "../plan-documents.ts";
import {
  defaultHeuristicsResponse,
  globalHeuristicsFile,
  projectHeuristicsFile,
  writeGlobalHeuristicsFile,
  writeProjectHeuristicsFile,
} from "../material-heuristics.ts";
import type { WebWorkDetailResponse } from "../../shared/api/web.ts";

export type WorkRouteDeps = {
  currentDirectory: string;
};

export function mountWorkRoutes(app: Hono, deps: WorkRouteDeps) {
  const { currentDirectory } = deps;

  const rawHeuristicsFromRequest = async (c: Context): Promise<string> => {
    const body = await c.req.json().catch(() => null) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body) && typeof (body as { raw?: unknown }).raw === "string") {
      return (body as { raw: string }).raw;
    }
    return `${JSON.stringify(body ?? {}, null, 2)}\n`;
  };
  app.get("/api/heuristics/defaults", (c) => c.json(defaultHeuristicsResponse()));
  app.get("/api/heuristics/global", (c) => {
    const result = globalHeuristicsFile();
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.put("/api/heuristics/global", async (c) => {
    const result = writeGlobalHeuristicsFile(await rawHeuristicsFromRequest(c));
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.get("/api/heuristics/project", (c) => {
    const workspaceRoot = c.req.query("workspaceRoot");
    if (!workspaceRoot) {
      return c.json({ error: "workspaceRoot is required" }, 400);
    }
    const result = projectHeuristicsFile(workspaceRoot);
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.put("/api/heuristics/project", async (c) => {
    const workspaceRoot = c.req.query("workspaceRoot");
    if (!workspaceRoot) {
      return c.json({ error: "workspaceRoot is required" }, 400);
    }
    const result = writeProjectHeuristicsFile(workspaceRoot, await rawHeuristicsFromRequest(c));
    return "config" in result ? c.json(result) : c.json(result, 400);
  });
  app.get("/api/plan-documents", async (c) => {
    const agents = queryAgents();
    return c.json(await indexPlanDocuments({
      currentDirectory,
      workspaces: agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        cwd: agent.cwd,
        project: agent.project,
        projectRoot: agent.projectRoot,
      })),
    }));
  });
  const handleListWork = (c: Context) => {
    const agentId = c.req.query("agentId");
    const conversationId = c.req.query("conversationId");
    const activeOnly = c.req.query("active") !== "false";
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isFinite(rawLimit)
      ? Math.min(250, Math.max(1, Math.floor(rawLimit)))
      : undefined;
    return c.json(
      queryWorkItems({
        agentId: agentId || undefined,
        conversationId: conversationId || undefined,
        activeOnly,
        limit,
      }),
    );
  };
  const handleWorkDetail = async (c: Context) => {
    const workId = c.req.param("id");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    const inventory = await buildWorkMaterialsInventory(detail);
    return c.json({ ...detail, inventory } satisfies WebWorkDetailResponse);
  };
  const handleWorkInventory = async (c: Context) => {
    const workId = c.req.param("id");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(await buildWorkMaterialsInventory(detail));
  };
  const handleWorkMaterialContent = async (c: Context) => {
    const workId = c.req.param("id");
    const materialId = c.req.query("materialId");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    if (!materialId) {
      return c.json({ error: "materialId is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await readWorkMaterialContent(detail, materialId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 410 | 415);
    }
    return c.json(result.content);
  };
  const handleWorkMaterialRaw = async (c: Context) => {
    const workId = c.req.param("id");
    const materialId = c.req.query("materialId");
    if (!workId) {
      return c.json({ error: "id is required" }, 400);
    }
    if (!materialId) {
      return c.json({ error: "materialId is required" }, 400);
    }
    const detail = queryWorkItemById(workId);
    if (!detail) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await readWorkMaterialRaw(detail, materialId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 410 | 415);
    }
    return new Response(Bun.file(result.realPath), {
      headers: {
        "content-type": result.mediaType,
        "cache-control": "private, max-age=60",
      },
    });
  };
  app.get("/api/work", handleListWork);
  app.get("/api/tasks", handleListWork);
  app.get("/api/work/:id", handleWorkDetail);
  app.get("/api/work/:id/inventory", handleWorkInventory);
  app.get("/api/work/:id/material", handleWorkMaterialContent);
  app.get("/api/work/:id/material/raw", handleWorkMaterialRaw);
  app.get("/api/tasks/:id", handleWorkDetail);
}
