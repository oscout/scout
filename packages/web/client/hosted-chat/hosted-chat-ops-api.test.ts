/**
 * Operator client: CSRF on writes, no fan-out inspect, agent tokens never sent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ChatApiError } from "../screens/chat-space/chat-api.ts";
import { HOSTED_OPS_PATHS, createHostedOpsApi } from "./hosted-chat-ops-api.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];
const SPACE_ID = "a".repeat(32);

type Responder = (call: RecordedCall) => Response;

function stubFetch(responder: Responder): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit & { body?: string }) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null,
    };
    calls.push(call);
    return Promise.resolve(responder(call));
  }) as typeof fetch;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("hosted operations client", () => {
  test("snapshot is one authenticated GET and does not inspect spaces", async () => {
    stubFetch((call) => {
      if (call.url === HOSTED_OPS_PATHS.session) {
        return json({ authenticated: true, account: { id: "op", displayName: "Op" }, csrfToken: "csrf-1" });
      }
      if (call.url === HOSTED_OPS_PATHS.snapshot) {
        return json({ spaces: [{ id: SPACE_ID, slug: "work" }], usage: { requests: 0 } });
      }
      return json({ error: "not_found" }, 404);
    });
    const api = createHostedOpsApi();
    await api.session();
    await api.snapshot();
    expect(calls.map((call) => call.url)).toEqual([HOSTED_OPS_PATHS.session, HOSTED_OPS_PATHS.snapshot]);
    expect(calls.some((call) => call.url.includes("/api/ops/spaces/"))).toBe(false);
  });

  test("mutations send CSRF and refuse to coerce a missing session into a write", async () => {
    stubFetch((call) => {
      if (call.url === HOSTED_OPS_PATHS.session) return json({ authenticated: false });
      return json({ error: "denied" }, 403);
    });
    const error = await createHostedOpsApi().setControl("invitesPaused", 1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).status).toBe(401);
    expect(calls.map((call) => call.url)).toEqual([HOSTED_OPS_PATHS.session]);
  });

  test("control writes carry JSON numbers and an inspect is explicit", async () => {
    stubFetch((call) => {
      if (call.url === HOSTED_OPS_PATHS.session) {
        return json({ authenticated: true, account: { id: "op", displayName: "Op" }, csrfToken: "csrf-1" });
      }
      if (call.url === HOSTED_OPS_PATHS.controls) return json({ ok: true });
      if (call.url === HOSTED_OPS_PATHS.space(SPACE_ID)) return json({ members: [], messageCount: 0, retainedPayloadBytes: 0 });
      return json({ error: "not_found" }, 404);
    });
    const api = createHostedOpsApi();
    await api.setControl("invitesPaused", 1);
    await api.inspect(SPACE_ID);
    expect(calls.at(1)).toMatchObject({
      url: HOSTED_OPS_PATHS.controls,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-1", accept: "application/json" },
      body: { key: "invitesPaused", value: 1 },
    });
    expect(calls.at(-1)?.url).toBe(HOSTED_OPS_PATHS.space(SPACE_ID));
    expect(calls.at(-1)?.method).toBe("GET");
  });

  test("unknown inspect ids fail locally instead of creating a Worker object", async () => {
    stubFetch(() => json({ error: "should-not-run" }, 500));
    const error = await createHostedOpsApi().inspect("not-a-space").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).reason).toBe("space_not_found");
    expect(calls).toEqual([]);
  });

  test("operator_required stays a 403, not an empty dashboard", async () => {
    stubFetch((call) => call.url === HOSTED_OPS_PATHS.snapshot
      ? json({ reason: "operator_required" }, 403)
      : json({ authenticated: true, csrfToken: "c" }));
    const api = createHostedOpsApi();
    await api.session();
    const error = await api.snapshot().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).status).toBe(403);
    expect((error as ChatApiError).reason).toBe("operator_required");
  });
});
