import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCOUT_REALTIME_VOICE_CALL_PATH,
  SCOUT_REALTIME_VOICE_LEASE_HEADER,
  SCOUT_REALTIME_VOICE_LEASE_PATH,
} from "../shared/realtime-voice.ts";
import {
  ScoutRealtimeVoiceAdmission,
  ScoutRealtimeVoiceAdmissionError,
  ScoutRealtimeVoiceError,
  createScoutRealtimeVoiceCall,
  isScoutRealtimeVoiceEnabled,
  readScoutRealtimeOffer,
  resolveScoutRealtimeVoiceAdmissionConfig,
  resolveScoutRealtimeVoiceConfig,
  validateScoutRealtimeOffer,
} from "./realtime-voice.ts";
import { mountScoutVoiceRoutes } from "./routes/voice.ts";
import { installScoutApiMiddleware } from "./server-core.ts";

function createTestAdmission(options: {
  now?: () => number;
  maxConcurrentCalls?: number;
  startsPerMinute?: number;
  leaseTtlMs?: number;
} = {}): ScoutRealtimeVoiceAdmission {
  let sequence = 0;
  return new ScoutRealtimeVoiceAdmission({
    database: new Database(":memory:"),
    config: {
      maxConcurrentCalls: options.maxConcurrentCalls ?? 1,
      startsPerMinute: options.startsPerMinute ?? 4,
      leaseTtlMs: options.leaseTtlMs ?? 90_000,
    },
    now: options.now,
    randomId: () => `lease-${String(++sequence).padStart(8, "0")}`,
  });
}

describe("Scout Realtime voice", () => {
  test("keeps the server call route closed unless the host enables it", async () => {
    const app = new Hono();
    let resolvedApiKey = false;
    mountScoutVoiceRoutes(app, {
      realtimeVoiceEnabled: () => false,
      resolveOpenAIApiKey: async () => {
        resolvedApiKey = true;
        return "sk-test";
      },
    });

    const response = await app.request(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
        "x-openscout-feature-realtime-voice": "on",
      },
      body: "v=0\r\noffer\r\n",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("OPENSCOUT_REALTIME_VOICE_ENABLED=1"),
    });
    expect(resolvedApiKey).toBe(false);
  });

  test("admits one call across the server boundary and releases its lease", async () => {
    const admission = createTestAdmission();
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      realtimeVoiceEnabled: () => true,
      realtimeVoiceAdmission: admission,
      resolveOpenAIApiKey: async () => "sk-test",
      createRealtimeVoiceCall: async () => "v=0\r\nanswer\r\n",
    });

    const first = await app.request(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\noffer\r\n",
    });
    const leaseId = first.headers.get(SCOUT_REALTIME_VOICE_LEASE_HEADER);
    expect(first.status).toBe(200);
    expect(leaseId).toBe("lease-00000001");
    expect(admission.activeLeaseCount()).toBe(1);

    const stacked = await app.request(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\noffer\r\n",
    });
    expect(stacked.status).toBe(429);
    expect(stacked.headers.get("retry-after")).toBe("90");
    expect(await stacked.json()).toEqual({ error: expect.stringContaining("still active") });

    const heartbeat = await app.request(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/${leaseId}`, {
      method: "PUT",
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ expiresAt: expect.any(Number) });

    const released = await app.request(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/${leaseId}`, {
      method: "DELETE",
    });
    expect(released.status).toBe(204);
    expect(admission.activeLeaseCount()).toBe(0);
  });

  test("releases admission when the upstream call fails", async () => {
    const admission = createTestAdmission();
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      realtimeVoiceEnabled: () => true,
      realtimeVoiceAdmission: admission,
      resolveOpenAIApiKey: async () => "sk-test",
      createRealtimeVoiceCall: async () => {
        throw new ScoutRealtimeVoiceError("Could not reach OpenAI Realtime.", 502);
      },
    });

    const response = await app.request(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\noffer\r\n",
    });
    expect(response.status).toBe(502);
    expect(admission.activeLeaseCount()).toBe(0);
  });

  test("rate limits repeated starts even after their leases are released", () => {
    let now = 1_000_000;
    const admission = createTestAdmission({
      now: () => now,
      startsPerMinute: 2,
    });
    const first = admission.admit();
    admission.release(first.id);
    now += 1_000;
    const second = admission.admit();
    admission.release(second.id);

    const error = (() => {
      try {
        admission.admit();
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ScoutRealtimeVoiceAdmissionError);
    expect(error).toEqual(expect.objectContaining({ status: 429, retryAfterSeconds: 59 }));
  });

  test("shares concurrency state between separate SQLite connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-realtime-admission-"));
    const databasePath = join(directory, "admission.sqlite");
    const config = { maxConcurrentCalls: 1, startsPerMinute: 4, leaseTtlMs: 90_000 };
    const firstWorker = new ScoutRealtimeVoiceAdmission({
      databasePath,
      config,
      randomId: () => "lease-worker-0001",
    });
    const secondWorker = new ScoutRealtimeVoiceAdmission({
      databasePath,
      config,
      randomId: () => "lease-worker-0002",
    });
    try {
      firstWorker.admit();
      expect(() => secondWorker.admit()).toThrow(ScoutRealtimeVoiceAdmissionError);
    } finally {
      firstWorker.close();
      secondWorker.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds chunked SDP before buffering the whole request", async () => {
    const oversizedOffer = new TextEncoder().encode(`v=0\r\n${"x".repeat(65 * 1024)}`);
    const request = new Request("http://localhost/realtime", {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversizedOffer);
          controller.close();
        },
      }),
    });
    expect(request.headers.get("content-length")).toBeNull();
    const error = await readScoutRealtimeOffer(request).catch((caught) => caught);
    expect(error).toEqual(expect.objectContaining({ status: 413 }));
  });

  test("does not expose SQLite diagnostics when admission is unavailable", async () => {
    const admission = createTestAdmission();
    admission.admit = () => {
      throw new Error("database is locked at /private/control-plane.sqlite");
    };
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      realtimeVoiceEnabled: () => true,
      realtimeVoiceAdmission: admission,
      resolveOpenAIApiKey: async () => "sk-test",
    });

    const response = await app.request(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\noffer\r\n",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Realtime voice admission is temporarily unavailable. Try again shortly.",
    });
  });

  test("rejects cross-origin call attempts before resolving credentials", async () => {
    const app = new Hono();
    let resolvedApiKey = false;
    installScoutApiMiddleware(app, "test");
    mountScoutVoiceRoutes(app, {
      realtimeVoiceEnabled: () => true,
      resolveOpenAIApiKey: async () => {
        resolvedApiKey = true;
        return "sk-test";
      },
    });

    const response = await app.request(`http://localhost${SCOUT_REALTIME_VOICE_CALL_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
        origin: "https://evil.example",
      },
      body: "v=0\r\noffer\r\n",
    });
    expect(response.status).toBe(403);
    expect(resolvedApiKey).toBe(false);
  });

  test("sends the browser offer and Scout-owned session config through the server", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const answer = await createScoutRealtimeVoiceCall({
      offerSdp: "v=0\r\noffer",
      apiKey: "sk-test",
      config: {
        model: "gpt-test-realtime",
        voice: "marin",
        instructions: "Use concise replies.",
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response("v=0\r\nanswer", { status: 200 });
      },
    });

    expect(answer).toBe("v=0\r\nanswer");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer sk-test");
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("sdp")).toBe("v=0\r\noffer");
    expect(JSON.parse(String(form.get("session")))).toEqual({
      type: "realtime",
      model: "gpt-test-realtime",
      audio: {
        input: {
          noise_reduction: { type: "far_field" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.6,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: "marin" },
      },
      instructions: "Use concise replies.",
      tools: [
        {
          type: "function",
          name: "ask_scoutbot",
          description: expect.stringContaining("live Scoutbot control-plane assistant"),
          parameters: {
            type: "object",
            properties: {
              request: {
                type: "string",
                description: expect.stringContaining("operator's complete request"),
              },
            },
            required: ["request"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
    });
  });

  test("does not leak an upstream error response through the browser route", async () => {
    const error = await createScoutRealtimeVoiceCall({
      offerSdp: "v=0\r\noffer",
      apiKey: "sk-test",
      fetchImpl: async () => new Response('{"error":{"message":"invalid key"}}', { status: 401 }),
    }).catch((caught) => caught);

    expect(error).toEqual(expect.objectContaining({
      name: "ScoutRealtimeVoiceError",
      status: 502,
      message: expect.stringContaining("401"),
    }));
    expect(error).toEqual(expect.objectContaining({
      message: expect.not.stringContaining("invalid key"),
    }));
  });

  test("validates browser SDP before making an upstream call", () => {
    const offer = "v=0\r\noffer\r\n";
    expect(validateScoutRealtimeOffer(offer)).toBe(offer);
    expect(() => validateScoutRealtimeOffer("not an offer")).toThrow(ScoutRealtimeVoiceError);
  });

  test("keeps the documented defaults configurable at the server boundary", () => {
    expect(resolveScoutRealtimeVoiceConfig({
      OPENSCOUT_REALTIME_MODEL: "gpt-test-realtime",
      OPENSCOUT_REALTIME_VOICE: "cedar",
      OPENSCOUT_REALTIME_INSTRUCTIONS: "Be direct.",
    })).toEqual({
      model: "gpt-test-realtime",
      voice: "cedar",
      instructions: "Be direct.",
    });
  });

  test("requires explicit server enablement and keeps admission defaults configurable", () => {
    expect(isScoutRealtimeVoiceEnabled({})).toBe(false);
    expect(isScoutRealtimeVoiceEnabled({ OPENSCOUT_REALTIME_VOICE_ENABLED: "yes" })).toBe(true);
    expect(resolveScoutRealtimeVoiceAdmissionConfig({
      OPENSCOUT_REALTIME_VOICE_MAX_CONCURRENT: "2",
      OPENSCOUT_REALTIME_VOICE_STARTS_PER_MINUTE: "6",
      OPENSCOUT_REALTIME_VOICE_LEASE_TTL_MS: "120000",
    })).toEqual({
      maxConcurrentCalls: 2,
      startsPerMinute: 6,
      leaseTtlMs: 120_000,
    });
  });
});
