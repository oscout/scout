import { expect, test } from "bun:test";
import { Hono } from "hono";
import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";
import { mountScoutbotThreadRoutes, type ScoutbotThreadRouteDeps } from "./scoutbot-threads.ts";

test("Scoutbot can use bundled choices when the published catalog is offline", async () => {
  const created: unknown[] = [];
  const app = new Hono();
  mountScoutbotThreadRoutes(app, {
    currentDirectory: "/project",
    readRunnerOptions: async () => { throw new Error("not used"); },
    readRuntimeCatalog: async () => null,
    scoutbot: { runner: { createThread: async (input: unknown) => { created.push(input); return { threadId: "test" }; } } } as unknown as ScoutbotThreadRouteDeps["scoutbot"],
  });
  const response = await app.request("/api/scoutbot/threads", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-sol", reasoningEffort: "medium" }),
  });
  expect(response.status).toBe(201);
  expect(created).toEqual([expect.objectContaining({ model: "gpt-6-sol", reasoningEffort: "medium" })]);
});

test("Scoutbot submits a new published model and rejects disabled choices and unsupported effort", async () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const codex = catalog.harnesses.find((harness) => harness.id === "codex")!;
  codex.models = codex.models.map((model) => ({ ...model, enabled: false, default: false }));
  codex.models.push({ id: "gpt-published-next", label: "Published Next", enabled: true, default: true, reasoningEfforts: ["high"] });
  const created: unknown[] = [];
  const app = new Hono();
  mountScoutbotThreadRoutes(app, {
    currentDirectory: "/project",
    readRunnerOptions: async () => { throw new Error("not used"); },
    readRuntimeCatalog: async () => ({ catalog, warnings: [] }),
    scoutbot: { runner: { createThread: async (input: unknown) => { created.push(input); return { threadId: "test" }; } } } as unknown as ScoutbotThreadRouteDeps["scoutbot"],
  });
  const request = (model: string, reasoningEffort: string) => app.request("/api/scoutbot/threads", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, reasoningEffort }),
  });
  expect((await request("gpt-6-sol", "medium")).status).toBe(400);
  expect((await request("gpt-published-next", "medium")).status).toBe(400);
  expect(created).toHaveLength(0);
  expect((await request("gpt-published-next", "high")).status).toBe(201);
  expect(created).toEqual([expect.objectContaining({ model: "gpt-published-next", reasoningEffort: "high" })]);
});
