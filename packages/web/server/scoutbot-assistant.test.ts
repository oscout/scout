import { describe, expect, test } from "bun:test";
import {
  createScoutbotAssistantService,
  createScoutbotSentenceSplitter,
  ScoutbotAssistantError,
  type ScoutbotCodexAssistantInvocation,
} from "./scoutbot-assistant.ts";

function makeService(options: { activeLimit?: number } = {}) {
  let responseCount = 0;
  return createScoutbotAssistantService({
    currentDirectory: "/tmp/openscout",
    loadContext: () => ({ ok: true }),
    env: {
      OPENAI_API_KEY: "sk-test",
      ...(options.activeLimit ? { OPENSCOUT_SCOUTBOT_ACTIVE_SESSION_LIMIT: String(options.activeLimit) } : {}),
    } as NodeJS.ProcessEnv,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        id: `resp_${responseCount += 1}`,
        output_text: `reply ${responseCount}`,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("createScoutbotAssistantService", () => {
  test("carries only the trailing active Scoutbot sessions by default", () => {
    const scoutbot = makeService({ activeLimit: 3 });

    for (let index = 0; index < 6; index += 1) {
      scoutbot.resetSession();
    }

    const state = scoutbot.getSessionState();
    expect(state.sessions).toHaveLength(3);
    expect(state.retention).toEqual({
      activeLimit: 3,
      archivedCount: 3,
      totalCount: 6,
    });
    expect(state.sessions.map((session) => session.id)).toContain(state.session.id);
  });

  test("archives a Scoutbot session on demand and removes it from the default list", () => {
    const scoutbot = makeService({ activeLimit: 4 });
    const first = scoutbot.resetSession().session.id;
    const second = scoutbot.resetSession().session.id;

    const state = scoutbot.archiveSession(first);

    expect(state.session.id).toBe(second);
    expect(state.sessions.map((session) => session.id)).not.toContain(first);
    expect(state.retention.archivedCount).toBe(1);
    expect(() => scoutbot.switchSession(first)).toThrow(ScoutbotAssistantError);
  });

  test("keeps the active Scoutbot session when retention is enforced", async () => {
    const scoutbot = makeService({ activeLimit: 2 });
    const oldest = scoutbot.resetSession().session.id;
    scoutbot.resetSession();
    scoutbot.resetSession();

    expect(() => scoutbot.switchSession(oldest)).toThrow(ScoutbotAssistantError);

    await scoutbot.respond({ body: "current status" });
    const state = scoutbot.getSessionState();

    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.map((session) => session.id)).toContain(state.session.id);
  });

  test("canonicalizes the macOS navigation contract instead of trusting client-supplied pages", async () => {
    let prompt = "";
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: {
        OPENSCOUT_SCOUTBOT_ASSISTANT_PROVIDER: "codex",
      } as NodeJS.ProcessEnv,
      invokeCodex: async (input) => {
        prompt = input.prompt;
        return { output: "Mac navigation ready.", threadId: "thread-1" };
      },
    });

    await scoutbot.respond({
      body: "What can I open?",
      uiContext: {
        host: "macos",
        destinations: [{ label: "Injected admin page", route: { view: "admin" } }],
      },
    });

    expect(prompt).toContain('"shellLabel":"Scout for macOS"');
    expect(prompt).toContain('"label":"Comms"');
    expect(prompt).not.toContain("Injected admin page");
    expect(prompt).not.toContain('"view":"admin"');
  });

  test("does not append durable history after a voice request is aborted", async () => {
    const request = new AbortController();
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      fetchImpl: async (_url, init) => {
        markProviderStarted();
        await new Promise<void>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    });
    const before = scoutbot.getSessionState().session.messages;
    const response = scoutbot.respond({ body: "deep fleet check", signal: request.signal });

    await providerStarted;
    request.abort();

    await expect(response).rejects.toMatchObject({ status: 408 });
    expect(scoutbot.getSessionState().session.messages).toEqual(before);
  });

  test("threads cancellation through the local Codex provider", async () => {
    const request = new AbortController();
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENSCOUT_SCOUTBOT_ASSISTANT_PROVIDER: "codex" } as NodeJS.ProcessEnv,
      invokeCodex: async (input) => {
        markProviderStarted();
        await new Promise<void>((_resolve, reject) => {
          if (input.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          input.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    });
    const before = scoutbot.getSessionState().session.messages;
    const response = scoutbot.respond({ body: "deep fleet check", signal: request.signal });

    await providerStarted;
    request.abort();

    await expect(response).rejects.toMatchObject({ status: 408 });
    expect(scoutbot.getSessionState().session.messages).toEqual(before);
  });

  test("session recap does not append conversational Scoutbot history", async () => {
    let prompt = "";
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ fleet: "should-not-appear" }),
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      fetchImpl: async (_url, init) => {
        prompt = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "resp_recap",
          output_text: "Still writing the parser.",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const before = scoutbot.getSessionState().session.messages;
    const summary = await scoutbot.summarizeSessionRecap({
      body: JSON.stringify({ sessionRef: "sess-1", evidence: [] }),
      systemPrompt: "You are Scout's spoken session-recap narrator.",
    });
    expect(summary).toBe("Still writing the parser.");
    expect(scoutbot.getSessionState().session.messages).toEqual(before);
    expect(prompt).not.toContain("should-not-appear");
    expect(prompt).not.toContain("Current Scout control-plane snapshot");
  });
});

describe("createScoutbotSentenceSplitter", () => {
  const collect = (chunks: string[]): string[] => {
    const splitter = createScoutbotSentenceSplitter();
    const out: string[] = [];
    for (const chunk of chunks) out.push(...splitter.push(chunk));
    out.push(...splitter.flush());
    return out;
  };

  test("cuts at sentence-ending punctuation followed by whitespace", () => {
    expect(collect(["One. Two! Three? Four… Five: six."])).toEqual([
      "One.",
      "Two!",
      "Three?",
      "Four…",
      "Five:",
      "six.",
    ]);
  });

  test("waits for whitespace when a delta ends on punctuation", () => {
    const splitter = createScoutbotSentenceSplitter();
    expect(splitter.push("Hello.")).toEqual([]);
    expect(splitter.push(" World.")).toEqual(["Hello."]);
    expect(splitter.flush()).toEqual(["World."]);
  });

  test("does not cut decimals, initials-adjacent digits, or punctuation runs mid-token", () => {
    expect(collect(["It cost 3.5 dollars. Wait... really?! Yes."])).toEqual([
      "It cost 3.5 dollars.",
      "Wait...",
      "really?!",
      "Yes.",
    ]);
  });

  test("flushes a runaway buffer at a word boundary", () => {
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const splitter = createScoutbotSentenceSplitter({ maxLength: 240 });
    const out = splitter.push(words);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeLessThan(240);
    expect(words.startsWith(out[0]! + " ")).toBe(true);
    expect(splitter.flush().join(" ")).toBe(words.slice(out[0]!.length + 1));
  });

  test("hard-cuts a runaway token without splitting a surrogate pair", () => {
    const splitter = createScoutbotSentenceSplitter({ maxLength: 40 });
    const runaway = "x".repeat(39) + "🙂" + "y".repeat(10);
    const out = splitter.push(runaway);
    expect(out).toHaveLength(1);
    expect([...out[0!]].length).toBe(39);
    expect(out[0]!.endsWith("x")).toBe(true);
    const rest = splitter.flush();
    expect((out.concat(rest)).join("")).toBe(runaway);
  });

  test("keeps emoji and multibyte punctuation intact across deltas", () => {
    const splitter = createScoutbotSentenceSplitter();
    expect(splitter.push("Great job 👋🏽. Next")).toEqual(["Great job 👋🏽."]);
    expect(splitter.push(" step … done.")).toEqual(["Next step …"]);
    expect(splitter.flush()).toEqual(["done."]);
  });

  test("never emits empty or whitespace-only sentences", () => {
    const splitter = createScoutbotSentenceSplitter();
    expect(splitter.push("   \n  ")).toEqual([]);
    expect(splitter.push(". . \n")).toEqual([".", "."]);
    expect(splitter.flush()).toEqual([]);
  });

  test("drops fenced machine payload and resumes speakable text after it", () => {
    const splitter = createScoutbotSentenceSplitter();
    const out: string[] = [];
    out.push(...splitter.push("Opening Fleet. ```scout-ui\n"));
    expect(out).toEqual(["Opening Fleet."]);
    expect(splitter.push("{\"type\":\"navigate\"}\n``` Done now.")).toEqual([]);
    out.push(...splitter.flush());
    expect(out).toEqual(["Opening Fleet.", "Done now."]);
  });

  test("drops an unterminated fence at flush but keeps text held before it", () => {
    expect(collect(["Partial answer ```json {\"a\": 1"])).toEqual(["Partial answer"]);
  });

  test("flush emits the remainder with no trailing punctuation", () => {
    expect(collect(["Streaming works"])).toEqual(["Streaming works"]);
  });
});

describe("respondStream", () => {
  const sseBody = (events: unknown[]): string =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

  const sseResponse = (events: unknown[]): Response =>
    new Response(sseBody(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  const completedEvent = (text: string, id = "resp_stream_1") => ({
    type: "response.completed",
    response: {
      id,
      output_text: text,
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    },
  });

  test("streams sentences as deltas arrive and returns the same reply shape as respond", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return sseResponse([
          { type: "response.output_text.delta", delta: "Fleet is quiet." },
          { type: "response.output_text.delta", delta: " Two agents are" },
          { type: "response.output_text.delta", delta: " idle." },
          completedEvent("Fleet is quiet. Two agents are idle."),
        ]);
      },
    });

    const sentences: string[] = [];
    const reply = await scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    });

    expect(sentences).toEqual(["Fleet is quiet.", "Two agents are idle."]);
    expect(reply.reply.body).toBe("Fleet is quiet. Two agents are idle.");
    expect(reply.responseId).toBe("resp_stream_1");
    expect(reply.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(reply.session.messages[1]!.body).toBe("Fleet is quiet. Two agents are idle.");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.stream).toBe(true);

    // The streamed response id threads into the next turn exactly like respond().
    const followup = scoutbot.respondStream({
      body: "and now?",
      onSentence: () => undefined,
    });
    await expect(followup).resolves.toBeDefined();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.previous_response_id).toBeUndefined();
    expect(JSON.stringify(requests[1]!.input)).toContain("Prior conversation");
    expect(JSON.stringify(requests[1]!.input)).toContain("and now?");
  });

  test("falls back to a whole-reply emission when the upstream answers plain JSON", async () => {
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      fetchImpl: async () =>
        new Response(JSON.stringify({
          id: "resp_plain",
          output_text: "All quiet. Nothing to add.",
        }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const sentences: string[] = [];
    const reply = await scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    });

    expect(sentences).toEqual(["All quiet.", "Nothing to add."]);
    expect(reply.reply.body).toBe("All quiet. Nothing to add.");
    expect(reply.responseId).toBe("resp_plain");
  });

  test("falls back to the non-streaming call when streaming fails before any delta", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let calls = 0;
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      fetchImpl: async (_url, init) => {
        calls += 1;
        requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "stream unsupported" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: "resp_fallback",
          output_text: "Recovered reply.",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const sentences: string[] = [];
    const reply = await scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    });

    expect(sentences).toEqual(["Recovered reply."]);
    expect(reply.reply.body).toBe("Recovered reply.");
    expect(reply.responseId).toBe("resp_fallback");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.stream).toBe(true);
    expect(requests[1]!.stream).toBeUndefined();
  });

  test("does not retry when the stream fails after a delta landed", async () => {
    let calls = 0;
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      fetchImpl: async () => {
        calls += 1;
        return sseResponse([
          { type: "response.output_text.delta", delta: "Half a reply." },
          {
            type: "response.failed",
            response: { status: "failed", error: { message: "upstream melted" } },
          },
        ]);
      },
    });
    const before = scoutbot.getSessionState().session.messages;

    const sentences: string[] = [];
    await expect(scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    })).rejects.toMatchObject({ status: 502, message: "upstream melted" });

    expect(sentences).toEqual(["Half a reply."]);
    expect(calls).toBe(1);
    expect(scoutbot.getSessionState().session.messages).toEqual(before);
  });

  test("routes non-OpenAI providers through the whole-reply fallback", async () => {
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENSCOUT_SCOUTBOT_ASSISTANT_PROVIDER: "codex" } as NodeJS.ProcessEnv,
      invokeCodex: async () => ({ output: "Codex says hi.", threadId: "thread-9" }),
    });

    const sentences: string[] = [];
    const reply = await scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    });

    expect(sentences).toEqual(["Codex says hi."]);
    expect(reply.reply.body).toBe("Codex says hi.");
    expect(reply.responseId).toBe("thread-9");
  });

  test("does not append durable history when a streamed voice request is aborted", async () => {
    const request = new AbortController();
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      fetchImpl: async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              sseBody([{ type: "response.output_text.delta", delta: "First sentence. " }]),
            ));
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            }, { once: true });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const before = scoutbot.getSessionState().session.messages;

    const sentences: string[] = [];
    const pending = scoutbot.respondStream({
      body: "status?",
      signal: request.signal,
      onSentence: (sentence) => sentences.push(sentence),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    request.abort();

    await expect(pending).rejects.toMatchObject({ status: 408 });
    expect(scoutbot.getSessionState().session.messages).toEqual(before);
  });
});

describe("provider ladder", () => {
  const openAIService = (overrides: {
    agentAvailable?: () => boolean;
    invokeCodex?: (input: ScoutbotCodexAssistantInvocation) => Promise<{ output: string; threadId: string }>;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {}) => {
    const fetchCalls: Array<Record<string, unknown>> = [];
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: {
        OPENAI_API_KEY: "sk-test",
        ...overrides.env,
      } as NodeJS.ProcessEnv,
      agentAvailable: overrides.agentAvailable,
      invokeCodex: overrides.invokeCodex
        ?? (async () => ({ output: "Codex reply.", threadId: "thread-ladder" })),
      fetchImpl: overrides.fetchImpl ?? (async (_url, init) => {
        fetchCalls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({
          id: "resp_ladder",
          output_text: "OpenAI reply.",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    return { scoutbot, fetchCalls };
  };

  test("auto prefers the agent path when it can launch", async () => {
    const { scoutbot, fetchCalls } = openAIService({ agentAvailable: () => true });

    const reply = await scoutbot.respond({ body: "status?" });

    expect(reply.reply.body).toBe("Codex reply.");
    expect(reply.responseId).toBe("thread-ladder");
    expect(fetchCalls).toHaveLength(0);
    expect(scoutbot.getConfig().effectiveProvider).toBe("codex");
  });

  test("auto falls back to OpenAI when the agent path cannot launch", async () => {
    const { scoutbot, fetchCalls } = openAIService({
      agentAvailable: () => false,
      invokeCodex: async () => {
        throw new Error("must not be called");
      },
    });

    const reply = await scoutbot.respond({ body: "status?" });

    expect(reply.reply.body).toBe("OpenAI reply.");
    expect(fetchCalls).toHaveLength(1);
    expect(scoutbot.getConfig().effectiveProvider).toBe("openai");
  });

  test("auto falls back to OpenAI when the agent call fails before the first delta", async () => {
    const { scoutbot, fetchCalls } = openAIService({
      agentAvailable: () => true,
      invokeCodex: async () => {
        throw new Error("app-server would not start");
      },
    });

    const sentences: string[] = [];
    const reply = await scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    });

    expect(reply.reply.body).toBe("OpenAI reply.");
    expect(sentences).toEqual(["OpenAI reply."]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.stream).toBe(true);
    expect(reply.responseId).toBe("resp_ladder");
  });

  test("pinned agent provider never falls back to OpenAI", async () => {
    const { scoutbot, fetchCalls } = openAIService({
      env: { OPENSCOUT_SCOUTBOT_ASSISTANT_PROVIDER: "agent" } as NodeJS.ProcessEnv,
      invokeCodex: async () => {
        throw new Error("app-server would not start");
      },
    });

    await expect(scoutbot.respond({ body: "status?" })).rejects.toMatchObject({ status: 503 });
    expect(fetchCalls).toHaveLength(0);
    expect(scoutbot.getConfig().provider).toBe("agent");
    expect(scoutbot.getConfig().effectiveProvider).toBe("codex");
  });

  test("streams the agent path sentence by sentence", async () => {
    const { scoutbot, fetchCalls } = openAIService({
      agentAvailable: () => true,
      invokeCodex: async (input) => {
        input.onDelta?.("Fleet is quiet.");
        input.onDelta?.(" Two agents idle.");
        return { output: "Fleet is quiet. Two agents idle.", threadId: "thread-stream" };
      },
    });

    const sentences: string[] = [];
    const reply = await scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    });

    expect(sentences).toEqual(["Fleet is quiet.", "Two agents idle."]);
    expect(reply.reply.body).toBe("Fleet is quiet. Two agents idle.");
    expect(reply.responseId).toBe("thread-stream");
    expect(fetchCalls).toHaveLength(0);
  });

  test("a mid-stream agent failure drains the partial tail and never retries or writes history", async () => {
    let calls = 0;
    const { scoutbot, fetchCalls } = openAIService({
      agentAvailable: () => true,
      invokeCodex: async (input) => {
        calls += 1;
        input.onDelta?.("Half a reply.");
        throw new Error("turn failed mid-stream");
      },
    });
    const before = scoutbot.getSessionState().session.messages;

    const sentences: string[] = [];
    await expect(scoutbot.respondStream({
      body: "status?",
      onSentence: (sentence) => sentences.push(sentence),
    })).rejects.toMatchObject({ status: 503 });

    expect(sentences).toEqual(["Half a reply."]);
    expect(calls).toBe(1);
    expect(fetchCalls).toHaveLength(0);
    expect(scoutbot.getSessionState().session.messages).toEqual(before);
  });

  test("the configured model reaches the agent invocation per call", async () => {
    const seenModels: Array<string | null | undefined> = [];
    const { scoutbot } = openAIService({
      agentAvailable: () => true,
      invokeCodex: async (input) => {
        seenModels.push(input.model);
        return { output: "ok", threadId: "thread-model" };
      },
    });

    await scoutbot.respond({ body: "first" });
    scoutbot.updateConfig({ model: "gpt-5.6-terra" });
    await scoutbot.respond({ body: "second" });

    expect(seenModels).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });

  test("auto with neither provider available keeps the honest 503", async () => {
    const scoutbot = createScoutbotAssistantService({
      currentDirectory: "/tmp/openscout",
      loadContext: () => ({ ok: true }),
      env: {} as NodeJS.ProcessEnv,
      agentAvailable: () => false,
      invokeCodex: async () => ({ output: "unreachable", threadId: "t" }),
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });

    await expect(scoutbot.respond({ body: "status?" })).rejects.toMatchObject({ status: 503 });
    expect(scoutbot.getConfig().effectiveProvider).toBe(null);
  });
});


describe("PR979 reply isolation regressions", () => {
  test("rejects overlapping same-chat stream/plain requests before invoking a provider", async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createScoutbotAssistantService({
      currentDirectory: "/tmp", loadContext: () => ({}), env: {},
      invokeCodex: async () => { calls++; await gate; return { output: "First.", threadId: "t" }; },
    });
    const first = service.respondStream({ body: "first", onSentence: () => {} });
    await expect(service.respond({ body: "second" })).rejects.toMatchObject({ status: 409 });
    await expect(service.respondStream({ body: "third", onSentence: () => {} })).rejects.toMatchObject({ status: 409 });
    release();
    await first;
    expect(calls).toBe(1);
    expect(service.getSessionState().session.messages.map((m) => m.body)).toEqual(["first", "First."]);
    await service.respond({ body: "after completion" });
    expect(calls).toBe(2);
  });

  test("keeps completion attached to its originating chat after a session switch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}), env: {},
      invokeCodex: async () => { await gate; return { output: "Old reply.", threadId: "t" }; },
    });
    const id = service.getSessionState().session.id;
    const pending = service.respond({ body: "old" });
    const other = service.resetSession().session.id;
    release();
    expect((await pending).session.id).toBe(id);
    expect(service.getSessionState().session.id).toBe(other);
    expect(service.getSessionState().session.messages).toHaveLength(0);
  });

  for (const stream of [false, true]) {
    test(`requester timeout stays terminal (stream=${stream}) and late deltas are fenced`, async () => {
      let late: ((delta: string) => void) | undefined;
      let fetches = 0;
      const sentences: string[] = [];
      const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}),
        env: { OPENAI_API_KEY: "mock" },
        invokeCodex: async (input) => {
          late = input.onDelta;
          throw Object.assign(new Error("Timed out"), { code: "REQUESTER_WAIT_TIMEOUT" });
        },
        fetchImpl: async () => { fetches++; throw new Error("unexpected fallback"); },
      });
      const request = stream ? service.respondStream({ body: "test", onSentence: (s) => sentences.push(s) })
        : service.respond({ body: "test" });
      await expect(request).rejects.toMatchObject({ status: 504 });
      late?.("Too late. ");
      expect(sentences).toEqual([]);
      expect(fetches).toBe(0);
      expect(service.getSessionState().session.messages).toHaveLength(0);
    });
  }

  test("replays retained history across agent -> OpenAI -> agent without stale continuation ids", async () => {
    const agentInputs: ScoutbotCodexAssistantInvocation[] = [];
    const requests: any[] = [];
    const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}),
      env: { OPENAI_API_KEY: "mock" },
      invokeCodex: async (input) => {
        agentInputs.push(input);
        if (agentInputs.length === 2) throw new Error("unavailable");
        return { output: "Agent answer.", threadId: "thread" };
      },
      fetchImpl: async (_, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "r", output_text: "Fallback answer." }), { headers: { "content-type": "application/json" } });
      },
    });
    await service.respond({ body: "Remember 42" });
    await service.respondStream({ body: "What number?", onSentence: () => {} });
    await service.respond({ body: "Continue" });
    expect(requests[0].input[0].content[0].text).toContain("Remember 42");
    expect(requests[0].input[0].content[0].text).toContain("Agent answer.");
    expect(requests[0].previous_response_id).toBeUndefined();
    expect(agentInputs[2]!.prompt).toContain("Fallback answer.");
    expect(agentInputs[2]!.threadId).toBeNull();
    expect(service.getSessionState().session.messages.map((m) => m.body)).toEqual([
      "Remember 42", "Agent answer.", "What number?", "Fallback answer.", "Continue", "Agent answer.",
    ]);
  });

  test("headers-success stalled SSE body times out, cancels reader and never retries", async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) => realSetTimeout(fn, ms === 60_000 ? 10 : ms, ...args)) as typeof setTimeout;
    let cancelled = false;
    let fetches = 0;
    try {
      const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}),
        env: { OPENAI_API_KEY: "mock", OPENSCOUT_SCOUTBOT_ASSISTANT_PROVIDER: "openai" },
        fetchImpl: async () => {
          fetches++;
          return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
        },
      });
      await expect(service.respondStream({ body: "test", onSentence: () => {} })).rejects.toMatchObject({ status: 504 });
      expect(cancelled).toBe(true);
      expect(fetches).toBe(1);
      expect(service.getSessionState().session.messages).toHaveLength(0);
    } finally { globalThis.setTimeout = realSetTimeout; }
  });

  test("settled failed attempt cannot emit into successful fallback", async () => {
    let late: ((delta: string) => void) | undefined;
    const sentences: string[] = [];
    const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}),
      env: { OPENAI_API_KEY: "mock" },
      invokeCodex: async (input) => { late = input.onDelta; throw new Error("offline"); },
      fetchImpl: async () => {
        late?.("Abandoned agent. ");
        return new Response(JSON.stringify({ id: "r", output_text: "Fallback." }), { headers: { "content-type": "application/json" } });
      },
    });
    await service.respondStream({ body: "test", onSentence: (s) => sentences.push(s) });
    late?.("After completion. ");
    expect(sentences).toEqual(["Fallback."]);
  });
});


test("plain replies do not fallback after an agent delta", async () => {
  let fetches = 0;
  const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}), env: { OPENAI_API_KEY: "mock" },
    invokeCodex: async (input) => { input.onDelta?.("Partial. "); throw new Error("lost connection"); },
    fetchImpl: async () => { fetches++; throw new Error("unexpected fallback"); },
  });
  await expect(service.respond({ body: "test" })).rejects.toThrow("lost connection");
  expect(fetches).toBe(0);
  expect(service.getSessionState().session.messages).toHaveLength(0);
});

test("cleanup failure is terminal rather than a fallback opportunity", async () => {
  let fetches = 0;
  const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}), env: { OPENAI_API_KEY: "mock" },
    invokeCodex: async () => { throw Object.assign(new Error("retirement failed"), { code: "SCOUTBOT_AGENT_CLEANUP_FAILED" }); },
    fetchImpl: async () => { fetches++; throw new Error("unexpected fallback"); },
  });
  await expect(service.respondStream({ body: "test", onSentence: () => {} })).rejects.toMatchObject({ status: 504 });
  expect(fetches).toBe(0);
});

test("completed OpenAI event ends an otherwise-open stream and fences late deltas", async () => {
  let cancelled = false;
  const sentences: string[] = [];
  const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}), env: { OPENAI_API_KEY: "mock" },
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(
        event({ type: "response.output_text.delta", delta: "Done. " })
        + event({ type: "response.completed", response: { id: "r", output_text: "Done." } })
        + event({ type: "response.output_text.delta", delta: "Late. " })
      )); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  expect((await service.respondStream({ body: "test", onSentence: (s) => sentences.push(s) })).reply.body).toBe("Done.");
  expect(sentences).toEqual(["Done."]);
  expect(cancelled).toBe(true);
});


test("abort before provider settlement drops buffered tail and releases same-chat exclusion", async () => {
  const controller = new AbortController();
  const sentences: string[] = [];
  let calls = 0;
  const service = createScoutbotAssistantService({ currentDirectory: "/tmp", loadContext: () => ({}), env: {},
    invokeCodex: async (input) => {
      if (++calls === 1) {
        input.onDelta?.("Buffered partial");
        controller.abort();
        input.onDelta?.(" late. ");
      }
      return { output: "Done.", threadId: "t" };
    },
  });
  await expect(service.respondStream({ body: "first", signal: controller.signal, onSentence: (s) => sentences.push(s) })).rejects.toMatchObject({ status: 408 });
  expect(sentences).toEqual([]);
  expect(service.getSessionState().session.messages).toHaveLength(0);
  expect((await service.respond({ body: "second" })).reply.body).toBe("Done.");
});

describe("budget advice completion after provider-ladder merge", () => {
  test("uses its cheap model and OpenAI without touching chat history or the agent", async () => {
    const requests: Record<string, unknown>[] = [];
    let agentCalls = 0;
    const service = createScoutbotAssistantService({
      currentDirectory: "/tmp", loadContext: () => ({}),
      env: { OPENAI_API_KEY: "mock", OPENSCOUT_BUDGET_ADVICE_MODEL: "gpt-4o-mini" },
      invokeCodex: async () => { agentCalls++; return { output: "Agent reply", threadId: "t" }; },
      fetchImpl: async (_, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "budget", output_text: "Use the provider with room." }),
          { headers: { "content-type": "application/json" } });
      },
    });
    const before = service.getSessionState();
    expect(await service.completeCheap({ systemPrompt: "Assess quotas", body: "Usage snapshot" }))
      .toEqual({ text: "Use the provider with room.", model: "gpt-4o-mini" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("gpt-4o-mini");
    expect(requests[0]!.previous_response_id).toBeUndefined();
    expect(agentCalls).toBe(0);
    expect(service.getSessionState()).toEqual(before);
  });

  test("missing API credentials never spend agent quota", async () => {
    let agentCalls = 0;
    const service = createScoutbotAssistantService({
      currentDirectory: "/tmp", loadContext: () => ({}), env: {},
      invokeCodex: async () => { agentCalls++; return { output: "Agent reply", threadId: "t" }; },
    });
    await expect(service.completeCheap({ systemPrompt: "Assess quotas", body: "Usage snapshot" }))
      .rejects.toMatchObject({ status: 503 });
    expect(agentCalls).toBe(0);
  });
});
