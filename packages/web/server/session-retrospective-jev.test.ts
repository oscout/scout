import { describe, expect, test } from "bun:test";
import type { SessionRefObservePayload } from "./core/observe/service.ts";
import { buildJevRequestBody, buildSessionRetrospectiveProfile } from "../shared/session-retrospective.ts";
import {
  DEFAULT_JEV_ENDPOINT,
  generateSessionRetrospectiveLabels,
  jevRetrospectiveStatus,
  resolveJevEndpoint,
  SessionRetrospectiveJevError,
} from "./session-retrospective-jev.ts";

function payload(overrides: Partial<SessionRefObservePayload> = {}): SessionRefObservePayload {
  return {
    kind: "history",
    refId: "codex-session-1",
    agentId: null,
    source: "history",
    fidelity: "timestamped",
    historyPath: "private/path.jsonl",
    sessionId: "codex-session-1",
    updatedAt: 100,
    data: {
      events: [
        { id: "event-1", t: 1, kind: "tool", tool: "Read", text: "secret user prompt", arg: "secret path" } as never,
        { id: "event-2", t: 2, kind: "tool", tool: "Edit", text: "secret source" } as never,
      ],
      files: [{ path: "private/path.ts", state: "modified", touches: 1, lastT: 2 }],
      live: false,
      metadata: { session: { adapterType: "codex", model: "private-model" } },
    },
    ...overrides,
  } as SessionRefObservePayload;
}

describe("generateSessionRetrospectiveLabels", () => {
  test("sends only the server-derived aggregate profile after explicit confirmation", async () => {
    let requestBody: Record<string, unknown> | null = null;
    let authorization = "";
    const observed = payload();
    const preview = buildSessionRetrospectiveProfile(observed.data);
    const result = await generateSessionRetrospectiveLabels({
      sessionRef: "codex-session-1",
      harness: "codex",
      confirmed: true,
      preview,
      apiKey: "test-secret-key",
      loadObserve: async () => observed,
      fetcher: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          model: "jev-1.13.0",
          answers: {
            exploration: { type: "noul", noul: 0.81 },
            implementation: { type: "noul", noul: 0.76 },
            debugging: { type: "noul", noul: 0.71 },
            delegation: { type: "noul", noul: 0.02 },
          },
          usage: { input_tokens: 123, output_tokens: 29 },
        });
      },
    });
    const serialized = JSON.stringify(requestBody);
    expect(authorization).toBe("Bearer test-secret-key");
    expect(serialized).toContain("readOrSearch");
    expect(serialized).not.toContain("secret user prompt");
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("private-model");
    expect(serialized).not.toContain("secret source");
    expect(result.labels.map((label) => label.id)).toEqual(["exploration", "implementation"]);
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 29 });
    expect(result.cost).toBeNull();
  });

  test("rejects missing confirmation and stale preview without calling Jev", async () => {
    let fetchCalls = 0;
    const base = {
      sessionRef: "codex-session-1",
      harness: "codex",
      preview: {},
      apiKey: "test-key",
      loadObserve: async () => payload(),
      fetcher: async () => { fetchCalls += 1; return Response.json({}); },
    };
    await expect(generateSessionRetrospectiveLabels({ ...base, confirmed: false }))
      .rejects.toBeInstanceOf(SessionRetrospectiveJevError);
    await expect(generateSessionRetrospectiveLabels({ ...base, confirmed: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(fetchCalls).toBe(0);
  });

  test("rejects live, mismatched, and unconfigured sessions", async () => {
    const observed = payload();
    const preview = buildSessionRetrospectiveProfile(observed.data);
    const call = (overrides: Parameters<typeof generateSessionRetrospectiveLabels>[0]) =>
      generateSessionRetrospectiveLabels({
        sessionRef: "codex-session-1",
        harness: "codex",
        confirmed: true,
        preview,
        loadObserve: async () => observed,
        ...overrides,
      });
    await expect(call({ apiKey: "", fetcher: fetch, loadObserve: async () => observed }))
      .rejects.toMatchObject({ status: 503 });
    await expect(generateSessionRetrospectiveLabels({
      sessionRef: "codex-session-1",
      harness: "codex",
      confirmed: true,
      preview,
      apiKey: "test",
      loadObserve: async () => ({ ...observed, data: { ...observed.data, live: true } }),
    })).rejects.toMatchObject({ status: 409 });
    await expect(generateSessionRetrospectiveLabels({
      sessionRef: "codex-session-1",
      harness: "codex",
      confirmed: true,
      preview,
      apiKey: "test",
      loadObserve: async () => ({ ...observed, data: { ...observed.data, metadata: { session: { adapterType: "claude" } } } }),
    })).rejects.toMatchObject({ status: 409 });
  });

  test("sends exactly the previewed request body, once, to the configured endpoint", async () => {
    const observed = payload();
    const preview = buildSessionRetrospectiveProfile(observed.data);
    const calls: Array<{ url: string; body: unknown }> = [];
    const run = (status: number) => generateSessionRetrospectiveLabels({
      sessionRef: "codex-session-1",
      harness: "codex",
      confirmed: true,
      preview,
      apiKey: "k",
      endpoint: "https://jev.example.test/v1/systemone",
      loadObserve: async () => observed,
      fetcher: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response("provider detail that must not surface", { status });
      },
    });
    await expect(run(500)).rejects.toMatchObject({ status: 502 });
    await expect(run(429)).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://jev.example.test/v1/systemone");
    expect(calls[0]!.body).toEqual(JSON.parse(JSON.stringify(buildJevRequestBody(preview))));
  });

  test("refuses non-https endpoints except loopback", async () => {
    expect(resolveJevEndpoint(undefined)).toBe(DEFAULT_JEV_ENDPOINT);
    expect(resolveJevEndpoint("http://example.com/x")).toBeNull();
    expect(resolveJevEndpoint("https://user:pw@example.com/x")).toBeNull();
    expect(resolveJevEndpoint("not a url")).toBeNull();
    expect(resolveJevEndpoint("http://127.0.0.1:9999/v1")).toBe("http://127.0.0.1:9999/v1");
    let fetchCalls = 0;
    const observed = payload();
    await expect(generateSessionRetrospectiveLabels({
      sessionRef: "codex-session-1",
      harness: "codex",
      confirmed: true,
      preview: buildSessionRetrospectiveProfile(observed.data),
      apiKey: "k",
      endpoint: "http://example.com/v1",
      loadObserve: async () => observed,
      fetcher: async () => { fetchCalls += 1; return Response.json({}); },
    })).rejects.toMatchObject({ status: 503 });
    expect(fetchCalls).toBe(0);
  });

  test("status is off by default and never exposes the key", () => {
    expect(jevRetrospectiveStatus({})).toEqual({ available: false, endpoint: DEFAULT_JEV_ENDPOINT });
    const on = jevRetrospectiveStatus({ TYPESAFE_API_KEY: "secret-key" });
    expect(on.available).toBe(true);
    expect(JSON.stringify(on)).not.toContain("secret-key");
    expect(jevRetrospectiveStatus({ TYPESAFE_API_KEY: "k", OPENSCOUT_JEV_ENDPOINT: "http://example.com" }).available).toBe(false);
  });
});
