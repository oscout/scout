import type { Hono } from "hono";
import {
  SCOUT_RUNTIME_CATALOG,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeModelCatalog,
  scoutRuntimeReasoningEfforts,
  type ScoutRuntimeCapabilityCatalog,
} from "@openscout/protocol";
import { buildHudRunnerOptions, loadBrokerRuntimeCatalog } from "../hud-runner-options.ts";
import type { ScoutbotWebServices } from "./scoutbot.ts";
import { scoutbotThreadMessageBody } from "../../shared/api/scoutbot.ts";
import { readJsonBody } from "../request-body.ts";

export type ScoutbotThreadRouteDeps = {
  currentDirectory: string;
  readRunnerOptions: (scope: ScoutRuntimeCapabilityCatalog["scope"], projectRoot: string) => ReturnType<typeof buildHudRunnerOptions>;
  scoutbot: ScoutbotWebServices;
};

export function mountScoutbotThreadRoutes(app: Hono, deps: ScoutbotThreadRouteDeps) {
  const { scoutbot, readRunnerOptions, currentDirectory } = deps;

  app.get("/api/scoutbot/threads", async (c) => {
    const scoutbotRunner = scoutbot.runner ?? await scoutbot.waitForRunner();
    if (!scoutbotRunner) {
      return c.json({ error: "scoutbot runner is not enabled" }, 503);
    }
    try {
      const [threads, catalog] = await Promise.all([
        scoutbotRunner.getThreads(), readRunnerOptions("global", currentDirectory),
      ]);
      return c.json({ ...threads,
        defaultModel: catalog.defaultsByHarness.codex?.model ?? null,
        defaultReasoningEffort: catalog.defaultsByHarness.codex?.reasoningEffort ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, /broker unreachable/i.test(message) ? 502 : 500);
    }
  });

  app.post("/api/scoutbot/threads", async (c) => {
    const body = await c.req.json().catch(() => null) as {
      name?: unknown; model?: unknown; reasoningEffort?: unknown;
      pins?: { projectRoot?: unknown; topic?: unknown };
    } | null;
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const effort = typeof body?.reasoningEffort === "string" ? body.reasoningEffort.trim() : "";
    const catalog = (await loadBrokerRuntimeCatalog().catch(() => null))?.catalog ?? SCOUT_RUNTIME_CATALOG;
    if (!model || !scoutRuntimeModelCatalog(catalog).some((entry) => entry.id === model && entry.harnesses.includes("codex"))) {
      return c.json({ error: "Choose an available Codex model from the runtime catalog" }, 400);
    }
    const supportedEfforts = scoutRuntimeReasoningEfforts("codex", model, catalog) ?? [];
    if (effort && !supportedEfforts.some((entry) => entry === effort)) {
      return c.json({ error: "Reasoning effort is not supported by this model" }, 400);
    }
    const runner = scoutbot.runner ?? await scoutbot.waitForRunner();
    if (!runner) return c.json({ error: "scoutbot runner is not enabled" }, 503);
    try {
      const projectRoot = typeof body?.pins?.projectRoot === "string" ? body.pins.projectRoot.trim() : "";
      const topic = typeof body?.pins?.topic === "string" ? body.pins.topic.trim() : "";
      const thread = await runner.createThread({
        name: typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "New conversation",
        model,
        reasoningEffort: effort || scoutRuntimeDefaultReasoningEffort("codex", model, catalog) || undefined,
        pins: projectRoot || topic ? { ...(projectRoot ? { projectRoot } : {}), ...(topic ? { topic } : {}) } : null,
      });
      return c.json({ thread }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, /broker unreachable/i.test(message) ? 502 : 500);
    }
  });

  app.post("/api/scoutbot/messages", async (c) => {
    const parsed = await readJsonBody(c, scoutbotThreadMessageBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
    const messageBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!threadId || (!messageBody && !body.attachments?.length)) {
      return c.json({ error: "threadId and body or attachments are required" }, 400);
    }
    const runner = scoutbot.runner ?? await scoutbot.waitForRunner();
    if (!runner) return c.json({ error: "scoutbot runner is not enabled" }, 503);
    try {
      const result = await runner.postOperatorMessage({
        threadId, body: messageBody, attachments: body.attachments,
        replyToMessageId: typeof body.replyToMessageId === "string" ? body.replyToMessageId : undefined,
      });
      if (!result.usedBroker) return c.json({ error: "broker unreachable" }, 502);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, /unknown scoutbot thread/i.test(message) ? 404 : /scoutbot_turn_pending/.test(message) ? 409 : /scoutbot_runtime_fixed/.test(message) ? 400 : 500);
    }
  });
}
