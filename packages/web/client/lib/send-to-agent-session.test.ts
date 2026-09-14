import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { Agent } from "./types.ts";
import { sendToFocusedAgentSession } from "./send-to-agent-session.ts";

type CapturedRequest = { path: string; body: Record<string, unknown> | null };

function captureRequests(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

describe("sendToFocusedAgentSession", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a follow-up into an agent's chat carries no runtime request", async () => {
    // The card's harness and model are descriptive. Forwarding them as
    // `execution` turned every Mission Control send into an exact-runtime
    // request that the agent's live tmux session could not satisfy.
    const requests = captureRequests();
    const agent = {
      id: "project-woolf-20",
      name: "Woolf",
      harness: "claude",
      model: "claude-opus-5",
      conversationId: "chn-a73456b2198644baaf4eef611bcb492e",
      projectRoot: "/Users/art/dev/openscout",
      cwd: "/Users/art/dev/openscout",
      agentClass: "relay",
    } as Agent;

    const destination = await sendToFocusedAgentSession(agent, "Hello");

    expect(destination.conversationId).toBe("chn-a73456b2198644baaf4eef611bcb492e");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/api/send");
    expect(requests[0]?.body).toEqual({
      body: "Hello",
      chatId: "chn-a73456b2198644baaf4eef611bcb492e",
    });
    expect(requests[0]?.body).not.toHaveProperty("execution");
  });

  test("a native session is continued by id and harness without imposing its descriptive model", async () => {
    const requests = captureRequests();
    const agent = {
      id: "native:claude:7b81300d-0a9c-4953-8d7f-9274b11ebdfb",
      name: "openscout",
      agentClass: "native-session",
      harness: "claude",
      model: "claude-opus-5",
      harnessSessionId: "7b81300d-0a9c-4953-8d7f-9274b11ebdfb",
      projectRoot: "/Users/art/dev/openscout",
      cwd: "/Users/art/dev/openscout",
    } as Agent;

    const destination = await sendToFocusedAgentSession(agent, "Continue");

    expect(destination.conversationId).toBeNull();
    expect(requests[0]?.path).toBe("/api/sessions");
    expect(requests[0]?.body).toEqual(expect.objectContaining({
      execution: {
        session: "existing",
        targetSessionId: "7b81300d-0a9c-4953-8d7f-9274b11ebdfb",
        harness: "claude",
      },
    }));
  });
  test("reply boundary predates a response arriving before POST completion", async () => {
    let now = 100;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let release!: () => void;
    let posted!: () => void;
    const dispatched = new Promise<void>((resolve) => { posted = resolve; });
    globalThis.fetch = (async () => {
      posted();
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const pending = sendToFocusedAgentSession({ id: "agent-test", conversationId: "conversation-test" } as Agent, "hello");
      await dispatched;
      now = 101;
      const replyAt = now;
      now = 200;
      release();
      const destination = await pending;
      expect(destination.sentAt).toBe(100);
      expect(replyAt).toBeGreaterThanOrEqual(destination.sentAt);
    } finally { clock.mockRestore(); }
  });

});
