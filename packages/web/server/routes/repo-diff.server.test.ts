import { describe, expect, test } from "bun:test";
import {
  createOpenScoutWebServer,
  makeStaticRoot,
  waitForTestCondition,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: repo-diff routes", () => {
  function stubDiffSnapshot(worktreePath: string) {
    return {
      schema: "openscout.repo.diff/v1" as const,
      generatedAt: 1_780_760_000_000,
      worktreePath,
      layers: [],
      coverage: {
        requestedLayers: 0,
        emittedLayers: 0,
        files: 0,
        patchBytes: 0,
        truncatedLayers: 0,
        scanBudgetReached: false,
      },
      diagnostics: [],
      scout: { worktreeId: "w1", projectId: null, agents: [], sessions: [], hints: [] },
      render: {
        renderKey: "k1",
        cachePolicy: "local-disposable" as const,
        preferredTheme: "pierre-dark",
        preferredLayout: "split" as const,
      },
    };
  }

  test("serves repo-diff snapshots from the web server (no broker hop)", async () => {
    let captured: {
      worktreePath?: string;
      layers?: string[];
      baseRef?: string;
      paths?: string[];
      limits?: { timeoutMs?: number; includeBinaryPatch?: boolean };
    } | null = null;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      repoDiffSnapshot: async (opts) => {
        captured = {
          worktreePath: opts.worktreePath,
          layers: opts.layers,
          baseRef: opts.baseRef ?? undefined,
          paths: opts.paths,
          limits: opts.limits,
        };
        return stubDiffSnapshot(opts.worktreePath);
      },
    });

    const response = await server.app.request(
      "http://localhost/api/repo-diff/worktree?path=/tmp/wt&layer=staged&layer=unstaged&baseRef=main&ignored=true",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schema: "openscout.repo.diff/v1" });
    expect(captured?.worktreePath).toBe("/tmp/wt");
    // Layer order follows the request (the client controls tab order).
    expect(captured?.layers).toEqual(["staged", "unstaged"]);
    expect(captured?.baseRef).toBe("main");
    expect(captured?.limits).toMatchObject({
      timeoutMs: 15_000,
      includeBinaryPatch: false,
    });
  });

  test("passes repo-diff file filters through as native diff paths", async () => {
    let captured: { paths?: string[] } | null = null;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      repoDiffSnapshot: async (opts) => {
        captured = { paths: opts.paths };
        return stubDiffSnapshot(opts.worktreePath);
      },
    });

    const response = await server.app.request(
      "http://localhost/api/repo-diff/worktree?path=/tmp/wt&file=src/a.ts&file=/tmp/wt/src/b.ts&file=/tmp/elsewhere/nope.ts",
    );

    expect(response.status).toBe(200);
    expect(captured?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    await expect(response.json()).resolves.toMatchObject({
      scope: {
        kind: "worktree",
        filteredPaths: ["src/a.ts", "src/b.ts"],
      },
    });
  });

  test("serves cached repo-diff snapshots and rehydrates in the background", async () => {
    let calls = 0;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      repoDiffSnapshot: async (opts) => {
        calls += 1;
        return {
          ...stubDiffSnapshot(opts.worktreePath),
          generatedAt: calls,
          render: {
            ...stubDiffSnapshot(opts.worktreePath).render,
            renderKey: `k${calls}`,
          },
        };
      },
    });

    const live = await server.app.request(
      "http://localhost/api/repo-diff/worktree?path=/tmp/wt&cache=reload",
    );
    expect(live.status).toBe(200);
    expect(live.headers.get("x-openscout-repo-diff-cache")).toBe("miss");
    expect((await live.json() as { generatedAt: number }).generatedAt).toBe(1);
    expect(calls).toBe(1);

    const cached = await server.app.request(
      "http://localhost/api/repo-diff/worktree?path=/tmp/wt&cache=prefer&rehydrate=1",
    );
    expect(cached.status).toBe(200);
    expect(cached.headers.get("x-openscout-repo-diff-cache")).toBe("hit");
    expect(cached.headers.get("x-openscout-repo-diff-rehydrate")).toBe("queued");
    expect((await cached.json() as { generatedAt: number }).generatedAt).toBe(1);

    await waitForTestCondition(() => calls >= 2);

    const rehydrated = await server.app.request(
      "http://localhost/api/repo-diff/worktree?path=/tmp/wt&cache=only",
    );
    expect(rehydrated.status).toBe(200);
    expect(rehydrated.headers.get("x-openscout-repo-diff-cache")).toBe("hit");
    expect((await rehydrated.json() as { generatedAt: number }).generatedAt).toBe(2);
  });

  test("repo-diff cache-only misses do not run live commands", async () => {
    let called = false;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      repoDiffSnapshot: async (opts) => {
        called = true;
        return stubDiffSnapshot(opts.worktreePath);
      },
    });

    const response = await server.app.request(
      "http://localhost/api/repo-diff/worktree?path=/tmp/wt&cache=only",
    );

    expect(response.status).toBe(404);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      status: "missing",
      worktreePath: "/tmp/wt",
    });
  });

  test("repo-diff summary tier skips patch text and parsed hunks", async () => {
    let capturedLimits: Record<string, unknown> | undefined;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      repoDiffSnapshot: async (opts) => {
        capturedLimits = opts.limits;
        return stubDiffSnapshot(opts.worktreePath);
      },
    });

    const response = await server.app.request(
      "http://localhost/api/repo-diff/worktree?path=/tmp/wt&tier=summary",
    );

    expect(response.status).toBe(200);
    expect(capturedLimits).toMatchObject({
      includeRawPatch: false,
      includeParsedHunks: false,
      includeBinaryPatch: false,
    });
  });

  test("rejects repo-diff requests without a worktree path", async () => {
    let called = false;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      repoDiffSnapshot: async (opts) => {
        called = true;
        return stubDiffSnapshot(opts.worktreePath);
      },
    });

    const response = await server.app.request("http://localhost/api/repo-diff/worktree");
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});
