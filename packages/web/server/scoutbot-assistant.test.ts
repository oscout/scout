import { describe, expect, test } from "bun:test";
import {
  createScoutbotAssistantService,
  ScoutbotAssistantError,
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
});
