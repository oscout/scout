import { afterEach, describe, expect, test } from "bun:test";

import { streamScoutbotChat, type ScoutbotChatStreamFinal } from "./scoutbot-chat-stream.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(sseStream(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const finalPayload = {
  session: { id: "rgr_1", messages: [] },
  sessions: [],
  config: { model: "gpt-test" },
  reply: { id: "msg_1", role: "assistant", body: "One. Two.", createdAt: 1 },
  responseId: "resp_1",
  voiceTurn: { turn: 2, gen: 1 },
};

describe("streamScoutbotChat", () => {
  test("delivers sentence events in order, then the final payload", async () => {
    globalThis.fetch = (async () => sseResponse([
      // An event split across chunks, with an emoji straddling the boundary.
      "event: sentence\ndata: {\"text\":\"First sentence. ",
      " 👋\"}\n\nevent: sentence\ndata: {\"text\":\"Second.\"}\n\n",
      `event: final\ndata: ${JSON.stringify(finalPayload)}\n\n`,
    ])) as unknown as typeof fetch;

    const sentences: string[] = [];
    const finals: ScoutbotChatStreamFinal[] = [];
    await streamScoutbotChat({ body: "hi" }, {
      onSentence: (text) => sentences.push(text),
      onFinal: (reply) => {
        finals.push(reply);
      },
      onError: () => {
        throw new Error("unexpected error event");
      },
    });

    expect(sentences).toEqual(["First sentence.  👋", "Second."]);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.reply.body).toBe("One. Two.");
    expect(finals[0]!.voiceTurn).toEqual({ turn: 2, gen: 1 });
  });

  test("surfaces in-band error events with their status", async () => {
    globalThis.fetch = (async () => sseResponse([
      "event: sentence\ndata: {\"text\":\"Partial.\"}\n\n",
      `event: error\ndata: ${JSON.stringify({ error: "upstream went away", status: 502 })}\n\n`,
    ])) as unknown as typeof fetch;

    const sentences: string[] = [];
    const failures: Array<{ message: string; status: number }> = [];
    await streamScoutbotChat({ body: "hi" }, {
      onSentence: (text) => sentences.push(text),
      onFinal: () => {
        throw new Error("final must not follow an error event");
      },
      onError: (error) => {
        failures.push(error);
      },
    });

    expect(sentences).toEqual(["Partial."]);
    expect(failures).toEqual([{ message: "upstream went away", status: 502 }]);
  });

  test("throws the parsed error body on a non-OK response", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "body is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await expect(streamScoutbotChat({ body: "" }, {})).rejects.toThrow("body is required");
  });

  test("refreshes session auth once on a 401 and retries", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/scoutbot/chat" && calls.filter((call) => call.includes("/api/scoutbot/chat")).length === 1) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.startsWith("/api/bootstrap.js")) {
        return new Response("ok", { status: 200 });
      }
      return sseResponse([`event: final\ndata: ${JSON.stringify(finalPayload)}\n\n`]);
    }) as typeof fetch;

    const finals: ScoutbotChatStreamFinal[] = [];
    await streamScoutbotChat({ body: "hi" }, {
      onFinal: (reply) => {
        finals.push(reply);
      },
    });

    expect(finals[0]!.responseId).toBe("resp_1");
    expect(calls.filter((call) => call.includes("/api/scoutbot/chat"))).toHaveLength(2);
  });

  test("forwards the voiceTurn echo fields and stream flag in the request", async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return sseResponse([`event: final\ndata: ${JSON.stringify(finalPayload)}\n\n`]);
    }) as typeof fetch;

    await streamScoutbotChat({ body: "hi", voiceTurn: { turn: 5, gen: 2 } }, {});
    expect(sentBody.stream).toBe(true);
    expect(sentBody.voiceTurn).toEqual({ turn: 5, gen: 2 });
  });
});


describe("PR979 terminal stream fencing", () => {
  test("reports EOF without a terminal event", async () => {
    globalThis.fetch = (async () => sseResponse(['event: sentence\ndata: {"text":"Partial."}\n\n'])) as unknown as typeof fetch;
    await expect(streamScoutbotChat({ body: "test" }, {})).rejects.toThrow("before the reply completed");
  });
  test("ignores duplicate finals and sentences after terminal and cancels an open reader", async () => {
    let cancelled = false;
    const sentences: string[] = [];
    let finals = 0;
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: final\ndata: ${JSON.stringify(finalPayload)}\n\nevent: sentence\ndata: {"text":"Late."}\n\nevent: final\ndata: ${JSON.stringify(finalPayload)}\n\n`));
      },
      cancel() { cancelled = true; },
    }))) as unknown as typeof fetch;
    await streamScoutbotChat({ body: "test" }, { onFinal: () => { finals++; }, onSentence: (s) => sentences.push(s) });
    expect(finals).toBe(1);
    expect(sentences).toEqual([]);
    expect(cancelled).toBe(true);
  });
  test("abort cancels a mocked reader even when fetch ignores its signal", async () => {
    let cancelled = false;
    const controller = new AbortController();
    globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as unknown as typeof fetch;
    const pending = streamScoutbotChat({ body: "test", signal: controller.signal }, {});
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
});
