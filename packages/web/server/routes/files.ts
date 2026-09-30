import type { Hono } from "hono";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadRevealObservePayload, observedRevealPathSet } from "../observe-payload.ts";
import { execSystemFile } from "@openscout/runtime/system-probes";
import { collectTrustedRoots, readFilePreview, resolveTrustedPath } from "../file-preview.ts";
import { loadResolvedRelayAgents, readOpenScoutSettings, writeOpenScoutSettings } from "@openscout/runtime/setup";
import { addOpenScoutWorkspaceRoot } from "@openscout/runtime/onboarding";
import { serveRawFile } from "../http-helpers.ts";
import { expandHomePath, resolveExplorablePath } from "../local-paths.ts";
import type { CreateOpenScoutWebServerOptions } from "../web-server-options.ts";
import { projectAddBody } from "../../shared/api/files.ts";
import { readJsonBody } from "../request-body.ts";

function rawFilePathFromRoute(requestUrl: string): string | null {
  const pathname = new URL(requestUrl).pathname;
  const prefix = "/api/file/raw";
  if (!pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

function realpathIfExists(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

async function defaultRevealLocalPath(targetPath: string): Promise<void> {
  if (!existsSync(targetPath)) {
    throw new Error("Path does not exist.");
  }

  const stats = statSync(targetPath);
  const directory = stats.isDirectory() ? targetPath : dirname(targetPath);
  if (process.platform === "darwin") {
    await execSystemFile("open", stats.isDirectory() ? [targetPath] : ["-R", targetPath], { timeoutMs: 1_500 });
    return;
  }
  if (process.platform === "win32") {
    await execSystemFile("explorer.exe", stats.isDirectory() ? [targetPath] : [`/select,${targetPath}`], { timeoutMs: 1_500 });
    return;
  }

  await execSystemFile("xdg-open", [directory], { timeoutMs: 1_500 });
}

export type FileRouteDeps = {
  options: Pick<CreateOpenScoutWebServerOptions, "revealPath">;
  currentDirectory: string;
};

export function mountFileRoutes(app: Hono, deps: FileRouteDeps) {
  const { currentDirectory, options } = deps;

  app.get("/api/ui/scenes", async (c) => {
    const settings = await readOpenScoutSettings({ currentDirectory }).catch(() => null);
    return c.json(settings?.ui ?? { scenes: [], activeSceneIdBySurface: {} });
  });

  app.put("/api/ui/scenes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scenes?: unknown;
      activeSceneIdBySurface?: unknown;
    };
    try {
      const updated = await writeOpenScoutSettings({
        ui: {
          scenes: Array.isArray(body.scenes) ? (body.scenes as never) : [],
          activeSceneIdBySurface: typeof body.activeSceneIdBySurface === "object" && body.activeSceneIdBySurface
            ? (body.activeSceneIdBySurface as never)
            : {},
        },
      }, { currentDirectory });
      return c.json(updated.ui);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ui/scenes]", message);
      return c.json({ error: message }, 500);
    }
  });
  app.get("/api/file/roots", (c) => {
    const roots = collectTrustedRoots({ currentDirectory });
    return c.json({ roots });
  });

  app.get("/api/projects/overview", async (c) => {
    const projectRoot = c.req.query("root")?.trim();
    if (!projectRoot) {
      return c.json({ error: "missing root" }, 400);
    }
    const { buildProjectOverview } = await import("../project-overview.ts");
    const result = await buildProjectOverview({
      projectRoot,
      currentDirectory,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404);
    }
    return c.json(result.payload);
  });

  // One-off project registration: appends to discovery.workspaceRoots
  // (never replaces — that's the onboarding writer's job), then re-scans
  // and reports which projects actually appeared under the new root.
  app.post("/api/projects/add", async (c) => {
    const parsed = await readJsonBody(c, projectAddBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const requested = body.root?.trim();
    if (!requested) {
      return c.json({ error: "root is required" }, 400);
    }
    const root = resolve(expandHomePath(requested));
    if (!existsSync(root)) {
      return c.json({ error: `That folder doesn't exist: ${root}` }, 400);
    }
    if (!statSync(root).isDirectory()) {
      return c.json({ error: `Not a folder: ${root}` }, 400);
    }

    try {
      const { alreadyRegistered } = await addOpenScoutWorkspaceRoot({ root, currentDirectory });
      const setup = await loadResolvedRelayAgents({ currentDirectory });
      const registered = setup.projectInventory
        .filter((project) => project.projectRoot === root || project.projectRoot.startsWith(`${root}/`))
        .map((project) => ({
          id: project.agentId,
          title: project.displayName,
          root: project.projectRoot,
          source: project.source,
          registrationKind: project.registrationKind,
          defaultHarness: project.defaultHarness,
          projectConfigPath: project.projectConfigPath,
        }));
      return c.json({
        ok: true,
        root,
        alreadyRegistered,
        projects: registered,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[projects/add]", message);
      return c.json({ error: message }, 500);
    }
  });

  // Deep-link authority for /code/<project>/<path>: resolves a slug against
  // the canonical project inventory. Repo-watch only registers checkouts with
  // live agent activity, so a quiet-but-known checkout must resolve here.
  app.get("/api/code/resolve-project", async (c) => {
    const slug = c.req.query("slug")?.trim();
    if (!slug) {
      return c.json({ error: "slug is required" }, 400);
    }
    try {
      const { matchCodeProjectBySlug } = await import("../code-project-resolve.ts");
      const setup = await loadResolvedRelayAgents({ currentDirectory });
      const candidates = setup.projectInventory
        .map((project) => ({ displayName: project.displayName, projectRoot: project.projectRoot }))
        .filter((project) => existsSync(project.projectRoot));
      const match = matchCodeProjectBySlug(candidates, slug);
      if (!match) {
        return c.json({
          error: `Project "${slug}" is not in Scout's project inventory (${candidates.length} registered).`,
        }, 404);
      }
      return c.json({ ok: true, projectName: match.displayName, root: match.projectRoot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[code/resolve-project]", message);
      return c.json({ error: `Could not resolve project "${slug}": ${message}` }, 500);
    }
  });

  app.get("/api/file/preview", (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "missing path" }, 400);
    }
    const result = readFilePreview({ requestedPath, currentDirectory });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 415 | 500);
    }
    return c.json(result.content);
  });

  app.get("/api/file/raw/*", (c) =>
    serveRawFile(c, currentDirectory, rawFilePathFromRoute(c.req.url)),
  );

  app.get("/api/file/raw", (c) =>
    serveRawFile(c, currentDirectory, c.req.query("path")),
  );

  app.post("/api/file/reveal", async (c) => {
    const body = await c.req.json<{ path?: unknown }>().catch(() => null);
    const requestedPath = typeof body?.path === "string" ? body.path : "";
    if (!requestedPath.trim()) {
      return c.json({ error: "missing path" }, 400);
    }
    const roots = collectTrustedRoots({ currentDirectory });
    const resolved = resolveTrustedPath({ requestedPath, roots });
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, resolved.status as 400 | 403 | 404);
    }
    try {
      await (options.revealPath ?? defaultRevealLocalPath)(resolved.realPath);
      return c.json({ ok: true, path: resolved.realPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to reveal path";
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/local-path/reveal", async (c) => {
    const body = await c.req.json<{
      path?: unknown;
      basePath?: unknown;
      agentId?: unknown;
      sessionId?: unknown;
    }>().catch(() => null);
    const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!rawPath) {
      return c.json({ error: "missing path" }, 400);
    }
    const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!agentId && !sessionId) {
      return c.json({ error: "agentId or sessionId is required" }, 400);
    }

    const observePayload = await loadRevealObservePayload({ agentId, sessionId });
    if (!observePayload) {
      return c.json({ error: "observe payload not found" }, 404);
    }

    const basePath = typeof body?.basePath === "string" ? body.basePath : null;
    const targetPath = resolveExplorablePath(rawPath, basePath, currentDirectory);
    const realTargetPath = realpathIfExists(targetPath);
    if (!realTargetPath) {
      return c.json({ error: "path not found" }, 404);
    }
    if (!observedRevealPathSet(observePayload).has(realTargetPath)) {
      return c.json({ error: "path is not part of the observed session" }, 403);
    }

    try {
      await (options.revealPath ?? defaultRevealLocalPath)(realTargetPath);
      return c.json({ ok: true, path: realTargetPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to reveal path";
      return c.json({ error: message }, 500);
    }
  });
}
