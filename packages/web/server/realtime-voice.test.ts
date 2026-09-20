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
  SCOUT_REALTIME_VOICE_SETTINGS_PATH,
} from "../shared/realtime-voice.ts";
import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  ScoutRealtimeVoiceAdmission,
  ScoutRealtimeVoiceAdmissionError,
  ScoutRealtimeVoiceError,
  createScoutRealtimeVoiceCall,
  isScoutRealtimeVoiceEnabled,
  readScoutRealtimeOffer,
  resolveScoutRealtimeVoiceAdmissionConfig,
  resolveScoutRealtimeVoiceConfig,
  resolveScoutRealtimeVoiceSettings,
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
  test.each([
    {session:{id:"known-live"}},
    {session:{id:"known-live"},transport:{type:"sip",sdp:"v=0\r\nanswer"}},
  ])("invalid transport retains the learned provider handle for route cleanup: %p", async payload => {
    const db = new Database(":memory:"); const admission = new ScoutRealtimeVoiceAdmission({database:db});
    const app = new Hono(); const closed: string[] = [];
    const dispose = mountScoutVoiceRoutes(app, {realtimeVoiceEnabled:()=>true,realtimeVoiceAdmission:admission,
      resolveOpenAIApiKey:async()=>"fixture-key",
      createRealtimeVoiceCall:input=>createScoutRealtimeVoiceCall({...input,fetchImpl:(async()=>Response.json(payload)) as typeof fetch}),
      finalizeLiveSession:async id=>{closed.push(id);return {state:"confirmed",reason:"close_requested",seconds:1};},
    });
    try {
      const response = await app.request(SCOUT_REALTIME_VOICE_CALL_PATH,{method:"POST",body:"v=0\r\noffer"});
      expect(response.status).toBe(502); expect(closed).toEqual(["known-live"]);
      expect(db.query("SELECT session_id, state, attempts FROM live_provider_sessions").get()).toEqual({session_id:"known-live",state:"confirmed",attempts:1});
      expect(await response.text()).not.toContain("known-live");
    } finally { dispose(); db.close(); }
  });

  test("cancelled setup and repeated DELETE obey one shared retry cap and backoff", async () => {
    let now = 0; let closes = 0;
    const admission = createTestAdmission({now:()=>now}); const controller = new AbortController(); const app = new Hono();
    const dispose = mountScoutVoiceRoutes(app,{realtimeVoiceEnabled:()=>true,realtimeVoiceAdmission:admission,
      resolveOpenAIApiKey:async()=>"fixture-key",
      createRealtimeVoiceCall:async()=>{controller.abort();return {answerSdp:"v=0\r\nanswer",sessionId:"cancelled-live"};},
      finalizeLiveSession:async()=>{closes++;return {state:"unconfirmed",reason:"timeout"};},
    });
    const remove = () => app.request(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/lease-00000001`,{method:"DELETE"});
    try {
      await app.fetch(new Request("http://localhost"+SCOUT_REALTIME_VOICE_CALL_PATH,{method:"POST",body:"v=0\r\noffer",signal:controller.signal}));
      expect(closes).toBe(1);
      for(let i=0;i<4;i++) expect((await remove()).status).toBe(204);
      expect(closes).toBe(1);
      now=30001; await remove(); expect(closes).toBe(2);
      now=60002; await remove(); expect(closes).toBe(3);
      now=90003; await remove(); expect(closes).toBe(3); expect(admission.activeLeaseCount()).toBe(0);
    } finally { dispose(); }
  });

  test("rejected cleanup credentials consume the reserved attempt without exposing diagnostics", async () => {
    const db = new Database(":memory:"); const admission = new ScoutRealtimeVoiceAdmission({database:db});
    const lease = admission.admit(); admission.bindSession(lease.id,"known-live"); const app = new Hono(); let calls=0;
    const dispose = mountScoutVoiceRoutes(app,{realtimeVoiceEnabled:()=>false,realtimeVoiceAdmission:admission,
      resolveOpenAIApiKey:async()=>{calls++;throw new Error("private credential details");},
    });
    try {
      for(let i=0;i<3;i++) expect((await app.request(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/${lease.id}`,{method:"DELETE"})).status).toBe(204);
      expect(calls).toBe(1);
      expect(db.query("SELECT state, reason, attempts FROM live_provider_sessions").get()).toEqual({state:"unconfirmed",reason:"cleanup_exception",attempts:1});
    } finally { dispose(); db.close(); }
  });

  test("browser abort after provider creation still closes the retained session", async () => {
    const admission = createTestAdmission(); const controller = new AbortController();
    const closed: string[] = []; const app = new Hono();
    const dispose = mountScoutVoiceRoutes(app, {
      realtimeVoiceEnabled: () => true, realtimeVoiceAdmission: admission,
      resolveOpenAIApiKey: async () => "fixture-key",
      createRealtimeVoiceCall: async input => {
        controller.abort(); expect(input.signal?.aborted).toBe(false);
        return { answerSdp: "v=0\r\nanswer", sessionId: "aborted-live" };
      },
      finalizeLiveSession: async id => { closed.push(id); return {state:"confirmed",reason:"close_requested",seconds:1}; },
    });
    try {
      const response = await app.fetch(new Request("http://localhost"+SCOUT_REALTIME_VOICE_CALL_PATH, {method:"POST",body:"v=0\r\noffer",signal:controller.signal}));
      expect(response.status).toBe(409); expect(closed).toEqual(["aborted-live"]); expect(admission.activeLeaseCount()).toBe(0);
    } finally { dispose(); }
  });

  test("cleanup remains available after disable and retains browser finalization separately", async () => {
    const db = new Database(":memory:");
    const admission = new ScoutRealtimeVoiceAdmission({database:db});
    const lease = admission.admit(); admission.bindSession(lease.id,"live-disabled");
    const app = new Hono();
    const dispose = mountScoutVoiceRoutes(app, {realtimeVoiceEnabled:()=>false,realtimeVoiceAdmission:admission,
      resolveOpenAIApiKey:async()=>"fixture-key",finalizeLiveSession:async()=>({state:"unconfirmed",reason:"gone"})});
    try {
      const response = await app.request(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/${lease.id}`, {method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({state:"confirmed",reason:"close_requested",seconds:12})});
      expect(response.status).toBe(204); expect(admission.activeLeaseCount()).toBe(0);
      expect(db.query("SELECT state, client_state, client_usage_seconds FROM live_provider_sessions").get()).toEqual({state:"unconfirmed",client_state:"confirmed",client_usage_seconds:12});
    } finally { dispose(); db.close(); }
  });

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

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("Settings → Voice"),
    });
    expect(resolvedApiKey).toBe(false);
  });

  test("lets the operator toggle live voice without restarting the server", async () => {
    let configuredEnabled = false;
    const admission = createTestAdmission();
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      readRealtimeVoiceEnabled: async () => configuredEnabled,
      writeRealtimeVoiceEnabled: async (enabled) => {
        configuredEnabled = enabled;
        return configuredEnabled;
      },
      realtimeVoiceEnvironment: {},
      realtimeVoiceAdmission: admission,
      resolveOpenAIApiKey: async () => "sk-test",
      finalizeLiveSession: async () => ({state:"confirmed",reason:"close_requested",seconds:10}),
      createRealtimeVoiceCall: async () => ({ answerSdp: "v=0\r\nanswer\r\n", sessionId: "live_test" }),
    });

    const initial = await app.request(SCOUT_REALTIME_VOICE_SETTINGS_PATH);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      enabled: false,
      configuredEnabled: false,
      source: "settings",
      locked: false,
      model: DEFAULT_REALTIME_MODEL,
      voice: DEFAULT_REALTIME_VOICE,
    });

    const enabled = await app.request(SCOUT_REALTIME_VOICE_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual(expect.objectContaining({
      enabled: true,
      configuredEnabled: true,
      locked: false,
    }));

    const call = await app.request(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\noffer\r\n",
    });
    expect(call.status).toBe(200);
    expect(admission.activeLeaseCount()).toBe(1);

    const disabled = await app.request(SCOUT_REALTIME_VOICE_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual(expect.objectContaining({ enabled: false }));
    expect(admission.activeLeaseCount()).toBe(0);
  });

  test("keeps an explicit environment override locked", async () => {
    let wrote = false;
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      readRealtimeVoiceEnabled: async () => true,
      writeRealtimeVoiceEnabled: async (enabled) => {
        wrote = enabled;
        return enabled;
      },
      realtimeVoiceEnvironment: { OPENSCOUT_REALTIME_VOICE_ENABLED: "off" },
    });

    const snapshot = await app.request(SCOUT_REALTIME_VOICE_SETTINGS_PATH);
    expect(await snapshot.json()).toEqual({
      enabled: false,
      configuredEnabled: true,
      source: "environment",
      locked: true,
      model: DEFAULT_REALTIME_MODEL,
      voice: DEFAULT_REALTIME_VOICE,
    });

    const update = await app.request(SCOUT_REALTIME_VOICE_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(update.status).toBe(409);
    expect(wrote).toBe(false);
  });

  test("admits one call across the server boundary and releases its lease", async () => {
    const admission = createTestAdmission();
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      realtimeVoiceEnabled: () => true,
      realtimeVoiceAdmission: admission,
      resolveOpenAIApiKey: async () => "sk-test",
      finalizeLiveSession: async () => ({state:"confirmed",reason:"close_requested",seconds:10}),
      createRealtimeVoiceCall: async () => ({ answerSdp: "v=0\r\nanswer\r\n", sessionId: "live_test" }),
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
      finalizeLiveSession: async () => ({state:"confirmed",reason:"close_requested",seconds:10}),
      createRealtimeVoiceCall: async () => {
        throw new ScoutRealtimeVoiceError("Could not reach OpenAI Live.", 502);
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
      error: "Live voice setup is temporarily unavailable. Try again shortly.",
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
    const call = await createScoutRealtimeVoiceCall({
      offerSdp: "v=0\r\noffer",
      apiKey: "sk-test",
      config: {
        model: "gpt-test-live",
        voice: "marin",
        instructions: "Use concise replies.",
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({
          session: { id: "live_abc123" },
          transport: { type: "webrtc", sdp: "v=0\r\nanswer" },
        });
      },
    });

    expect(call).toEqual({ answerSdp: "v=0\r\nanswer", sessionId: "live_abc123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/live/sessions");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer sk-test");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      session: {
        model: "gpt-test-live",
        audio: { output: { voice: "marin" } },
        instructions: "Use concise replies.",
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: "v=0\r\noffer" },
    });
  });

  test("keeps host-local state out of an API-managed backend", async () => {
    let body: Record<string, unknown> = {};
    await createScoutRealtimeVoiceCall({
      offerSdp: "v=0\r\noffer",
      apiKey: "sk-test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          session: { id: "live_abc123" },
          transport: { type: "webrtc", sdp: "v=0\r\nanswer" },
        });
      },
    });

    // Scout's fleet state never leaves the host, so a Responses backend could
    // not answer a delegation. Session-level tools are gone with it.
    const session = body.session as Record<string, unknown>;
    expect(session.delegation).toEqual({ type: "client" });
    expect(session).not.toHaveProperty("tools");
    expect(session).not.toHaveProperty("tool_choice");
    // Live is full-duplex and rejects an input VAD profile outright.
    expect(session.audio).toEqual({ output: { voice: "marin" } });
  });

  test("fails loudly when Live answers without a usable WebRTC session", async () => {
    for (const payload of [
      "",
      "not json",
      JSON.stringify({ session: { id: "live_abc123" } }),
      "null",
      JSON.stringify({ session:{id:"live_wrong"}, transport:{type:"sip",sdp:"v=0\r\nanswer"} }),
      JSON.stringify({ transport: { type: "webrtc", sdp: "v=0\r\nanswer" } }),
    ]) {
      const error = await createScoutRealtimeVoiceCall({
        offerSdp: "v=0\r\noffer",
        apiKey: "sk-test",
        fetchImpl: async () => new Response(payload, { status: 200 }),
      }).catch((caught) => caught);
      expect(error).toEqual(expect.objectContaining({
        name: "ScoutRealtimeVoiceError",
        status: 502,
      }));
    }
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
      OPENSCOUT_REALTIME_MODEL: "gpt-test-live",
      OPENSCOUT_REALTIME_VOICE: "cedar",
      OPENSCOUT_REALTIME_INSTRUCTIONS: "Be direct.",
    })).toEqual({
      model: "gpt-test-live",
      voice: "cedar",
      instructions: "Be direct.",
    });
  });

  test("resolves operator settings with optional environment overrides", () => {
    expect(isScoutRealtimeVoiceEnabled({})).toBe(false);
    expect(isScoutRealtimeVoiceEnabled({ OPENSCOUT_REALTIME_VOICE_ENABLED: "yes" })).toBe(true);
    expect(resolveScoutRealtimeVoiceSettings(true, {})).toEqual({
      enabled: true,
      configuredEnabled: true,
      source: "settings",
      locked: false,
      model: DEFAULT_REALTIME_MODEL,
      voice: DEFAULT_REALTIME_VOICE,
    });
    expect(resolveScoutRealtimeVoiceSettings(false, {
      OPENSCOUT_REALTIME_VOICE_ENABLED: "on",
      OPENSCOUT_REALTIME_MODEL: "gpt-test-live",
      OPENSCOUT_REALTIME_VOICE: "cedar",
    })).toEqual({
      enabled: true,
      configuredEnabled: false,
      source: "environment",
      locked: true,
      model: "gpt-test-live",
      voice: "cedar",
    });
    expect(resolveScoutRealtimeVoiceSettings(true, {
      OPENSCOUT_REALTIME_VOICE_ENABLED: "off",
    })).toEqual({
      enabled: false,
      configuredEnabled: true,
      source: "environment",
      locked: true,
      model: DEFAULT_REALTIME_MODEL,
      voice: DEFAULT_REALTIME_VOICE,
    });
  });

  test("keeps admission defaults configurable", () => {
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
