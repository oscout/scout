import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  stubs,
  askScoutQuestionCalls,
  createOpenScoutWebServer,
  makeStaticRoot,
  parseSseEvents,
  useIsolatedOpenScoutHome,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();
const { compactScoutbotStateForSpeech } = await import("./scoutbot.ts");

describe("createOpenScoutWebServer: scoutbot routes", () => {
  test("routes Scoutbot ask actions through askScoutQuestion", async () => {
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = join(home, ".openscout");
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/api/scoutbot/actions/ask",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetLabel: "hudson",
          targetAgentId: "agent-hudson",
          body: "Can you check the broker handoff path?",
          channel: "ops",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      targetLabel: "hudson",
      conversationId: "c.agent-1",
      messageId: "msg-ask-1",
      flightId: "flt-ask-1",
      targetAgentId: "agent-1",
    });
    expect(askScoutQuestionCalls).toEqual([
      {
        senderId: "operator",
        targetLabel: "hudson",
        targetAgentId: "agent-hudson",
        body: "Can you check the broker handoff path?",
        channel: "ops",
        currentDirectory: "/tmp/openscout",
      },
    ]);
  });

  test("runs Scoutbot assistant through direct OpenAI control loop", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL = "gpt-test-scoutbot";
    const fetchCalls: Array<{
      input: string;
      body: Record<string, unknown>;
      authorization: string | null;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push({
        input: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({
        id: "resp_scoutbot_1",
        output_text: [
          "The control plane is quiet.",
          "```scout-ui",
          "{\"type\":\"navigate\",\"route\":{\"view\":\"fleet\"}}",
          "```",
        ].join("\n"),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      // Pin the agent path off so this test exercises the OpenAI provider.
      scoutbotAssistant: { agentAvailable: () => false },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "what's going on?",
        route: { view: "inbox" },
        voiceTurn: { turn: 4, gen: 9 },
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json() as {
      reply: { body: string };
      session: { messageCount: number; messages: Array<{ role: string; body: string }> };
      responseId: string | null;
      voiceTurn: { turn: number; gen: number };
    };
    expect(json.reply.body).toContain("control plane is quiet");
    expect(json.responseId).toBe("resp_scoutbot_1");
    expect(json.voiceTurn).toEqual({ turn: 4, gen: 9 });
    expect(json.session.messageCount).toBe(2);
    expect(json.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(askScoutQuestionCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].input).toBe("https://api.openai.com/v1/responses");
    expect(fetchCalls[0].authorization).toBe("Bearer sk-test");
    expect(fetchCalls[0].body).toMatchObject({
      model: "gpt-test-scoutbot",
      instructions: expect.stringContaining("not a peer agent"),
    });
    expect(JSON.stringify(fetchCalls[0].body)).toContain("Current Scout control-plane snapshot");
    expect(JSON.stringify(fetchCalls[0].body)).toContain("currentRoute");
    expect(JSON.stringify(fetchCalls[0].body)).toContain("fleet");
  });

  test("streams Scoutbot voice replies as sentence SSE events before the final payload", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL = "gpt-test-scoutbot";
    const fetchBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const sse = [
        { type: "response.output_text.delta", delta: "The control plane is quiet." },
        { type: "response.output_text.delta", delta: " No open requests." },
        {
          type: "response.completed",
          response: {
            id: "resp_scoutbot_stream",
            output_text: "The control plane is quiet. No open requests.",
            usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 },
          },
        },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      // Pin the agent path off so this test exercises the OpenAI provider.
      scoutbotAssistant: { agentAvailable: () => false },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "what's going on?",
        route: { view: "inbox" },
        voiceTurn: { turn: 7, gen: 3 },
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual(["sentence", "sentence", "final"]);
    expect(events[0]!.data).toEqual({ text: "The control plane is quiet." });
    expect(events[1]!.data).toEqual({ text: "No open requests." });
    const final = events[2]!.data as {
      reply: { body: string };
      responseId: string | null;
      voiceTurn: { turn: number; gen: number };
      session: { messages: Array<{ role: string; body: string }> };
    };
    expect(final.reply.body).toBe("The control plane is quiet. No open requests.");
    expect(final.responseId).toBe("resp_scoutbot_stream");
    expect(final.voiceTurn).toEqual({ turn: 7, gen: 3 });
    expect(final.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]!.stream).toBe(true);
  });

  test("Scoutbot overlapping chat requests expose 409 without starting a second provider", async () => {
    useIsolatedOpenScoutHome();
    delete process.env.OPENAI_API_KEY;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let calls = 0;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot(),
      scoutbotAssistant: { invokeCodex: async () => {
        calls++; started(); await pending;
        return { output: "First reply.", threadId: "isolated-first" };
      } },
    });
    const request = (stream: boolean) => server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?", stream }),
    });
    const first = await request(true);
    await entered;
    try {
      const second = await request(true);
      const events = parseSseEvents(await second.text());
      expect(events).toEqual([{ event: "error", data: {
        error: "This Scoutbot chat already has a reply in progress.", status: 409,
      } }]);
      const typed = await request(false);
      expect(typed.status).toBe(409);
      expect(await typed.json()).toMatchObject({ error: "This Scoutbot chat already has a reply in progress." });
      expect(calls).toBe(1);
    } finally { finish(); }
    expect(parseSseEvents(await first.text()).at(-1)?.event).toBe("final");
  });

  test("cancelling the Scoutbot response body aborts its provider and does not append history", async () => {
    useIsolatedOpenScoutHome();
    delete process.env.OPENAI_API_KEY;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
    let providerSignal: AbortSignal | undefined;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout", assetMode: "static", staticRoot: makeStaticRoot(),
      scoutbotAssistant: { invokeCodex: async (input) => {
        providerSignal = input.signal;
        started();
        return await new Promise<never>((_resolve, reject) => {
          input.signal!.addEventListener("abort", () => {
            observedAbort(); reject(new DOMException("Cancelled", "AbortError"));
          }, { once: true });
        });
      } },
    });
    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?", stream: true }),
    });
    await entered;
    await response.body!.cancel();
    await aborted;
    expect(providerSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = await (await server.app.request("http://localhost/api/scoutbot/session")).json() as { session: { messages: unknown[] } };
    expect(state.session.messages).toEqual([]);
  });

  test("ends the Scoutbot stream with an in-band error event on mid-stream failure", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      const sse = [
        { type: "response.output_text.delta", delta: "Partial answer." },
        {
          type: "response.failed",
          response: { status: "failed", error: { message: "upstream went away" } },
        },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      // Pin the agent path off so this test exercises the OpenAI provider.
      scoutbotAssistant: { agentAvailable: () => false },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?", stream: true }),
    });

    expect(response.status).toBe(200);
    const events = parseSseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual(["sentence", "error"]);
    expect(events[0]!.data).toEqual({ text: "Partial answer." });
    expect(events[1]!.data).toEqual({ error: "upstream went away", status: 502 });

    // The failed stream must not append durable history.
    const session = await server.app.request("http://localhost/api/scoutbot/session");
    const state = await session.json() as { session: { messages: unknown[] } };
    expect(state.session.messages).toEqual([]);
  });

  test("streams the Codex fallback as one whole-reply sentence event", async () => {
    useIsolatedOpenScoutHome();
    delete process.env.OPENAI_API_KEY;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      scoutbotAssistant: {
        invokeCodex: async () => ({
          output: "Codex fallback works. Two sentences here.",
          threadId: "codex-thread-stream",
        }),
      },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?", stream: true }),
    });

    expect(response.status).toBe(200);
    const events = parseSseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual(["sentence", "sentence", "final"]);
    expect(events[0]!.data).toEqual({ text: "Codex fallback works." });
    expect(events[1]!.data).toEqual({ text: "Two sentences here." });
    const final = events[2]!.data as { reply: { body: string }; responseId: string | null };
    expect(final.reply.body).toBe("Codex fallback works. Two sentences here.");
    expect(final.responseId).toBe("codex-thread-stream");
  });

  test("the spoken snapshot keeps organic harness sessions without commands or paths", () => {
    const empty = { totals: {}, activeAsks: [], needsAttention: [], recentCompleted: [], items: [] };
    const compact = compactScoutbotStateForSpeech({
      build: null,
      agents: [],
      fleet: { generatedAt: 1, activity: [{ id: "noise" }], ...empty },
      operatorAttention: null,
      broker: { generatedAt: 1, windowMs: 1, totals: {}, rates: {}, attempts: [] },
      briefingEvidence: { big: true },
      heartrate: { series: [] },
      activeWork: [],
      activeRuns: [],
      activeFlights: [],
      sessions: [],
      recentMessages: [],
      recentActivity: [],
      mesh: null,
      harnessActivity: {
        generatedAt: 2,
        totals: { processes: 11, transcripts: 30 },
        processes: Array.from({ length: 11 }, (_, i) => ({
          pid: 100 + i,
          source: "ps",
          harness: "claude",
          command: "claude --secret-flag",
          cwd: "/Users/art/dev/openscout",
          etime: "01:00",
        })),
        transcripts: [{ source: "codex", harness: "codex", sessionId: "s1", project: "openscout", cwd: "/x", transcriptPath: "/x/s1.jsonl", mtimeMs: 5, size: 9 }],
      },
    } as never);

    expect(compact.harnessActivity?.totals).toEqual({ processes: 11, transcripts: 30 });
    expect(compact.harnessActivity?.processes).toHaveLength(8);
    expect(compact.harnessActivity?.transcripts).toEqual([{ harness: "codex", project: "openscout", mtimeMs: 5 }]);
    const text = JSON.stringify(compact);
    expect(text).not.toContain("--secret-flag");
    expect(text).not.toContain("s1.jsonl");
    expect(text).not.toContain("briefingEvidence");
    expect(text).not.toContain("heartrate");
    expect(text).not.toContain("noise");
  });

  test("a Local Live turn prewarms, goes direct to OpenAI with reasoning off, and sends the slim snapshot", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "resp_voice_1", output_text: "All quiet." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    let codexCalled = false;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      scoutbotAssistant: {
        agentAvailable: () => true,
        invokeCodex: async () => {
          codexCalled = true;
          return { output: "codex", threadId: "codex-thread" };
        },
      },
    });

    const prewarm = await server.app.request("http://localhost/api/scoutbot/prewarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: { view: "voice" } }),
    });
    expect(prewarm.status).toBe(202);

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "anything need me?",
        route: { view: "voice" },
        uiContext: { surface: "web", usageMode: "local" },
      }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { reply: { body: string } }).reply.body).toBe("All quiet.");
    expect(codexCalled).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "none" } });
    const input = JSON.stringify(bodies[0]?.input);
    expect(input).toContain("Spoken reply:");
    const snapshot = input.slice(input.indexOf("Current Scout control-plane snapshot:"));
    expect(snapshot).toContain("fleet");
    expect(snapshot).not.toContain("briefingEvidence");
    expect(snapshot).not.toContain("heartrate");
  });

  test("routes Scoutbot chat to the agent path first when it can launch", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      scoutbotAssistant: {
        agentAvailable: () => true,
        invokeCodex: async (input) => ({
          output: `Agent brain answered on ${input.model ?? "unknown"}.`,
          threadId: "codex-thread-ladder",
        }),
      },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json() as { reply: { body: string }; responseId: string | null };
    expect(json.reply.body).toBe("Agent brain answered on gpt-5.6-luna.");
    expect(json.responseId).toBe("codex-thread-ladder");
    expect(fetchCalled).toBe(false);

    const config = await server.app.request("http://localhost/api/scoutbot/config");
    const configJson = await config.json() as { provider: string; effectiveProvider: string | null };
    expect(configJson.provider).toBe("auto");
    expect(configJson.effectiveProvider).toBe("codex");
  });

  test("streams agent deltas as SSE sentences before the final payload", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      throw new Error("OpenAI must not be called when the agent path serves the turn");
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      scoutbotAssistant: {
        agentAvailable: () => true,
        invokeCodex: async (input) => {
          input.onDelta?.("Agent first sentence.");
          input.onDelta?.(" Second sentence lands.");
          return {
            output: "Agent first sentence. Second sentence lands.",
            threadId: "codex-thread-deltas",
          };
        },
      },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?", stream: true, voiceTurn: { turn: 2, gen: 5 } }),
    });

    expect(response.status).toBe(200);
    const events = parseSseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual(["sentence", "sentence", "final"]);
    expect(events[0]!.data).toEqual({ text: "Agent first sentence." });
    expect(events[1]!.data).toEqual({ text: "Second sentence lands." });
    const final = events[2]!.data as {
      reply: { body: string };
      responseId: string | null;
      voiceTurn: { turn: number; gen: number };
    };
    expect(final.reply.body).toBe("Agent first sentence. Second sentence lands.");
    expect(final.responseId).toBe("codex-thread-deltas");
    expect(final.voiceTurn).toEqual({ turn: 2, gen: 5 });
  });

  test("creates a structured Scoutbot one-minute brief with TTL", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      authorization: string | null;
    }> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchCalls.push({
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({
        id: "resp_brief_1",
        output_text: JSON.stringify({
          title: "One-minute brief",
          summary: "The system is quiet.",
          steps: [
            {
              id: "fleet",
              label: "Fleet",
              route: { view: "inbox" },
              narration: "Fleet is quiet: no active work and available agents are standing by.",
            },
            {
              id: "ops",
              label: "Ops Tail",
              route: { view: "ops", mode: "tail" },
              narration: "Ops tail has no fresh failures in the current window.",
            },
          ],
          recommendation: "Start by checking the stale active Scout item.",
          actions: [
            { label: "Open Ops Tail", route: { view: "ops", mode: "tail" } },
          ],
        }),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      // Pin the agent path off so this test exercises the OpenAI provider.
      scoutbotAssistant: { agentAvailable: () => false },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        route: { view: "inbox" },
        ttlMs: 180_000,
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json() as {
      ttlMs: number;
      preparedAt: number;
      expiresAt: number;
      steps: Array<{ label: string; route: Record<string, unknown>; snapshot: { expiresAt: number } }>;
      recommendation: string;
      actions: Array<{ label: string; route: Record<string, unknown> }>;
    };
    expect(json.ttlMs).toBe(180_000);
    expect(json.expiresAt - json.preparedAt).toBe(180_000);
    expect(json.steps).toEqual([
      expect.objectContaining({
        label: "Fleet",
        route: { view: "inbox" },
        snapshot: expect.objectContaining({ expiresAt: json.expiresAt }),
      }),
      expect.objectContaining({
        label: "Ops Tail",
        route: { view: "ops", mode: "tail" },
      }),
    ]);
    expect(json.recommendation).toContain("stale active Scout item");
    expect(json.actions).toEqual([
      expect.objectContaining({
        label: "Open Ops Tail",
        route: { view: "ops", mode: "tail" },
      }),
    ]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].authorization).toBe("Bearer sk-test");
    expect(fetchCalls[0].body).toMatchObject({
      instructions: expect.stringContaining("Brief output mode (SCO-037 v1)"),
    });
    expect(JSON.stringify(fetchCalls[0].body)).toContain("currentRoute");
    expect(JSON.stringify(fetchCalls[0].body)).toContain("Prepare a one-minute OpenScout control-plane brief");
    expect(JSON.stringify(fetchCalls[0].body)).toContain("180 seconds");
    expect(askScoutQuestionCalls).toHaveLength(0);
  });

  test("caches the fleet home brief until its thirty-minute TTL expires and ignores refresh hints", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchCalls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchCalls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        id: "resp_fleet_home_brief",
        output_text: JSON.stringify({
          title: "Fleet brief",
          summary: "The local fleet is steady.",
          steps: [
            {
              id: "fleet",
              label: "Fleet",
              route: { view: "inbox" },
              narration: "Fleet is steady: no blocked asks, and organic sessions are visible in the recent tail.",
            },
          ],
          recommendation: "Open the tail if you want the freshest organic session detail.",
          actions: [],
        }),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      // Pin the agent path off so this test exercises the OpenAI provider.
      scoutbotAssistant: { agentAvailable: () => false },
    });

    const first = await server.app.request("http://localhost/api/fleet/brief");
    const second = await server.app.request("http://localhost/api/fleet/brief");
    const refreshed = await server.app.request("http://localhost/api/fleet/brief?refresh=1");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshed.status).toBe(200);
    const firstJson = await first.json() as { statement: string; ttlMs: number; sourceBriefId: string; observations: unknown[] };
    const secondJson = await second.json() as { statement: string; ttlMs: number; sourceBriefId: string };
    const refreshedJson = await refreshed.json() as { statement: string; ttlMs: number; sourceBriefId: string };
    expect(firstJson.statement).toBe("Fleet is steady: no blocked asks, and organic sessions are visible in the recent tail.");
    expect(firstJson.observations).toHaveLength(1);
    expect(firstJson.ttlMs).toBe(30 * 60_000);
    expect(secondJson.sourceBriefId).toBe(firstJson.sourceBriefId);
    expect(refreshedJson.sourceBriefId).toBe(firstJson.sourceBriefId);
    expect(refreshedJson.ttlMs).toBe(30 * 60_000);
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.stringify(fetchCalls[0])).toContain("1800 seconds");
    expect(JSON.stringify(fetchCalls[0])).toContain("Fleet-home hero mode");
    expect(JSON.stringify(fetchCalls[0])).toContain("Do NOT use the Fleet narration to repeat those counters");
    expect(JSON.stringify(fetchCalls[0])).toContain("what deserves the operator's next 30 seconds");
    expect(JSON.stringify(fetchCalls[0])).toContain("subtle signal could fall through the cracks");
    expect(JSON.stringify(fetchCalls[0])).toContain("stale or hidden obligations");
    expect(JSON.stringify(fetchCalls[0])).toContain("Each finding paragraph is one distinct observation");
    expect(JSON.stringify(fetchCalls[0])).toContain("clickable references must be grounded in concrete IDs");
    expect(JSON.stringify(fetchCalls[0])).toContain("briefingEvidence.agentLogMessages");
    expect(JSON.stringify(fetchCalls[0])).toContain("Bad pattern: inventory counter sentence.");
    expect(JSON.stringify(fetchCalls[0])).toContain("Never copy the examples or schema placeholders.");
  });

  test("stores and dismisses Scoutbot reminders without an OpenAI key", async () => {
    useIsolatedOpenScoutHome();
    delete process.env.OPENAI_API_KEY;
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const createResponse = await server.app.request("http://localhost/api/scoutbot/reminders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "check lattices status",
        delayMs: 180_000,
        context: { route: { view: "inbox" } },
      }),
    });

    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as {
      reminder: { id: string; body: string; status: string; dueAt: number };
      scheduled: Array<{ id: string }>;
      due: Array<{ id: string }>;
    };
    expect(created.reminder.body).toBe("check lattices status");
    expect(created.reminder.status).toBe("scheduled");
    expect(created.reminder.dueAt).toBeGreaterThan(Date.now());
    expect(created.scheduled).toEqual([expect.objectContaining({ id: created.reminder.id })]);
    expect(created.due).toEqual([]);

    const dueResponse = await server.app.request("http://localhost/api/scoutbot/reminders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "read current status",
        dueAt: Date.now() - 1000,
      }),
    });
    const due = await dueResponse.json() as {
      reminder: { id: string; status: string };
      due: Array<{ id: string; status: string }>;
    };
    expect(due.reminder.status).toBe("due");
    expect(due.due).toEqual([expect.objectContaining({ id: due.reminder.id, status: "due" })]);

    const dismissResponse = await server.app.request(`http://localhost/api/scoutbot/reminders/${due.reminder.id}/dismiss`, {
      method: "POST",
    });
    expect(dismissResponse.status).toBe(200);
    const dismissed = await dismissResponse.json() as {
      due: Array<{ id: string }>;
      reminders: Array<{ id: string; status: string }>;
    };
    expect(dismissed.due.find((reminder) => reminder.id === due.reminder.id)).toBeUndefined();
    expect(dismissed.reminders.find((reminder) => reminder.id === due.reminder.id)?.status).toBe("dismissed");
  });

  test("falls back to local Codex when Scoutbot assistant has no OpenAI key", async () => {
    useIsolatedOpenScoutHome();
    delete process.env.OPENAI_API_KEY;
    let fetchCalled = false;
    const codexCalls: Array<{
      sessionId: string;
      threadId?: string | null;
      prompt: string;
      systemPrompt: string;
    }> = [];
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      scoutbotAssistant: {
        invokeCodex: async (input) => {
          codexCalls.push({
            sessionId: input.sessionId,
            threadId: input.threadId,
            prompt: input.prompt,
            systemPrompt: input.systemPrompt,
          });
          return {
            output: "Codex fallback works.",
            threadId: "codex-thread-1",
          };
        },
      },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json() as {
      reply: { body: string };
      responseId: string | null;
      session: { messages: Array<{ role: string; body: string }> };
    };
    expect(json.reply.body).toBe("Codex fallback works.");
    expect(json.responseId).toBe("codex-thread-1");
    expect(json.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(fetchCalled).toBe(false);
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0].threadId).toBeNull();
    expect(codexCalls[0].prompt).toContain("Operator request:");
    expect(codexCalls[0].prompt).toContain("Current Scout control-plane snapshot");
    expect(codexCalls[0].systemPrompt).toContain("not a peer agent");
  });

  test("ignores a transient request supplied OpenAI key and still uses configured providers", async () => {
    useIsolatedOpenScoutHome();
    delete process.env.OPENAI_API_KEY;
    let fetchCalled = false;
    const codexCalls: Array<{ prompt: string }> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchCalled = true;
      void init;
      return new Response(JSON.stringify({
        id: "resp_scoutbot_request_key",
        output_text: "Request key works.",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      scoutbotAssistant: {
        invokeCodex: async (input) => {
          codexCalls.push({ prompt: input.prompt });
          return {
            output: "Request key ignored; Codex handled this.",
            threadId: "codex-thread-request-key",
          };
        },
      },
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "state?",
        openaiApiKey: "sk-request-test",
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json() as { reply: { body: string }; responseId: string | null };
    expect(json.reply.body).toContain("Codex handled this");
    expect(json.responseId).toBe("codex-thread-request-key");
    expect(fetchCalled).toBe(false);
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0].prompt).not.toContain("sk-request-test");
  });

  test("saves and uses the local Scoutbot OpenAI credential store", async () => {
    useIsolatedOpenScoutHome();
    delete process.env.OPENAI_API_KEY;
    const fetchCalls: Array<{ authorization: string | null }> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchCalls.push({
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({
        id: "resp_scoutbot_local_store_key",
        output_text: "Local store key works.",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const saveResponse = await server.app.request("http://localhost/api/scoutbot/credentials/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-local-store-test" }),
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toEqual({
      openai: {
        configured: true,
        source: "local-store",
        preview: "sk-lo...test",
      },
    });

    const credentialFile = join(process.env.OPENSCOUT_CONTROL_HOME ?? "", "scoutbot-credentials.json");
    expect(readFileSync(credentialFile, "utf8")).not.toContain("sk-local-store-test");

    const chatResponse = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?" }),
    });
    expect(chatResponse.status).toBe(200);
    expect(fetchCalls).toEqual([{ authorization: "Bearer sk-local-store-test" }]);

    const deleteResponse = await server.app.request("http://localhost/api/scoutbot/credentials/openai", {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      openai: {
        configured: false,
        source: "missing",
        preview: null,
      },
    });
  });

  test("uses the local Scout relay OpenAI key for Scoutbot assistant", async () => {
    delete process.env.OPENAI_API_KEY;
    stubs.scoutRelayConfigResult = { openaiApiKey: "sk-relay-test" };
    const fetchCalls: Array<{ authorization: string | null }> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchCalls.push({
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({
        id: "resp_scoutbot_relay_key",
        output_text: "Relay key works.",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/scoutbot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "state?" }),
    });

    expect(response.status).toBe(200);
    expect(fetchCalls).toEqual([{ authorization: "Bearer sk-relay-test" }]);
  });
});
