import { afterEach, describe, expect, test } from "bun:test";

import { startScoutRealtimeVoiceCall } from "./realtime-voice.ts";
import {
  SCOUT_REALTIME_VOICE_LEASE_HEADER,
  SCOUT_REALTIME_VOICE_LEASE_PATH,
  SCOUT_REALTIME_VOICE_SETTINGS_PATH,
} from "../../shared/realtime-voice.ts";

const originalFetch = globalThis.fetch;
const originalPeerConnection = globalThis.RTCPeerConnection;
const originalAudio = globalThis.Audio;
const originalNavigator = globalThis.navigator;

class FakeDataChannel extends EventTarget {
  static latest: FakeDataChannel | null = null;

  static acknowledgeClose = true;
  readonly sent: string[] = [];
  readyState: RTCDataChannelState = "open";

  constructor() {
    super();
    FakeDataChannel.latest = this;
  }

  send(value: string): void {
    this.sent.push(value);
    const sent = JSON.parse(value);
    if (sent.type === "session.close" && FakeDataChannel.acknowledgeClose) queueMicrotask(() => this.dispatchEvent(liveMessage({type:"session.closed",reason:"close_requested",session:{id:"live_test"},usage:{seconds:12}})));
    if (sent.type.endsWith(".append")) queueMicrotask(() => this.dispatchEvent(liveMessage({type:sent.type+"ed",client_event_id:sent.event_id})));
  }
}

class FakePeerConnection extends EventTarget {
  static startSession = true;
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  static latest: FakePeerConnection | null = null;

  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  closed = false;

  constructor() {
    super();
    FakePeerConnection.latest = this;
  }

  addTrack(): RTCRtpSender {
    return {} as RTCRtpSender;
  }

  createDataChannel(): RTCDataChannel {
    return new FakeDataChannel() as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\noffer\r\n" };
  }

  async setLocalDescription(offer: RTCSessionDescriptionInit): Promise<void> { this.localDescription = offer; }

  async setRemoteDescription(): Promise<void> {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
    if (FakePeerConnection.startSession) FakeDataChannel.latest?.dispatchEvent(liveMessage({type:"session.started",session:{id:"live_test"}}));
  }

  close(): void {
    this.closed = true;
  }
}

class FakeAudio {
  autoplay = false;
  srcObject: MediaProvider | null = null;

  async play(): Promise<void> {}

  pause(): void {}
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: originalPeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  FakeDataChannel.latest = null;
  FakeDataChannel.acknowledgeClose = true;
  FakePeerConnection.startSession = true;
  FakePeerConnection.latest = null;
});

describe("Scout Realtime voice client", () => {
  test("routes a Live client delegation through the existing Scoutbot chat loop", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const replies: string[] = [];
    const trace: string[] = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      fetchCalls.push({ url: String(url), init });
      if (String(url) === "/api/voice/realtime/call") {
        return new Response("v=0\r\nanswer\r\n", {
          status: 200,
          headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-client-0001" },
        });
      }
      return new Response(JSON.stringify({
        reply: {
          body: [
            "The fleet is healthy.",
            "```scout-ui",
            '{"type":"ask-agent","targetLabel":"Hudson","body":"Check the worker pool"}',
            "```",
          ].join("\n"),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => {}, addEventListener: () => {} }],
          }),
        },
      },
    });

    let currentRoute: unknown = { view: "inbox" };
    const call = await startScoutRealtimeVoiceCall({
      getRoute: () => currentRoute,
      getUiContext: () => ({ host: "macos" }),
      onScoutbotReply: (body) => {
        replies.push(body);
        return {
          agentRequests: { requested: 1, sent: 1, failed: 0 },
        };
      },
      onTrace: (event) => trace.push(event.label),
    });
    expect(call.leaseId).toBe("lease-client-0001");
    const events = FakeDataChannel.latest;
    expect(events).not.toBeNull();
    events?.dispatchEvent(new Event("open"));
    // Voice and instructions are fixed server-side, so the only opening event
    // is speakable context rather than a session reconfiguration.
    expect(JSON.parse(events?.sent[0] ?? "null")).toEqual({
      type: "session.instructions.append",
      event_id: expect.any(String),
      delegation_id: null,
      content: expect.stringContaining("Scoutbot"),
    });

    currentRoute = { view: "fleet" };
    // A delegation event carries no task text, so the request has to come from
    // the transcript the session streamed before it.
    events?.dispatchEvent(liveMessage({
      type: "session.input_transcript.delta",
      delta: "What is happening in the fleet?",
    }));
    events?.dispatchEvent(liveMessage({
      type: "session.delegation.created",
      delegation: { id: "delegation-1", type: "delegation", target: "client" },
    }));

    await waitFor(() => fetchCalls.length === 2 && replies.length === 1);

    expect(new Headers(fetchCalls[0]?.init?.headers).get("content-type")).toBe("application/sdp");
    expect(fetchCalls[1]?.url).toBe("/api/scoutbot/chat");
    expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toEqual({body:expect.stringContaining("What is happening in the fleet?"),route:{view:"fleet"},uiContext:{host:"macos"},usageMode:"api"});
    expect(replies).toEqual([expect.stringContaining("The fleet is healthy.")]);
    expect(trace).toEqual(expect.arrayContaining([
      "Live session ready",
      "Scoutbot is checking the control plane",
      "Scoutbot reply ready",
    ]));
    const commentary = events?.sent
      .map((value) => JSON.parse(value))
      .filter((event) => event.delegation_id === "delegation-1") ?? [];
    expect(commentary).toHaveLength(1);
    expect(commentary[0]).toEqual({
      type: "session.commentary.append",
      delegation_id: "delegation-1",
      event_id: expect.any(String),
      // Delivery outcome rides inside the spoken text; there is no structured
      // tool result for the model to reason over under client delegation.
      content: expect.stringContaining("sent automatically"),
    });
    expect(commentary[0].content).toContain("sent automatically");
    expect(commentary[0].content).not.toContain("scout-ui");
    await call.stop();
    await waitFor(() => fetchCalls.some((entry) => (
      entry.url === `${SCOUT_REALTIME_VOICE_LEASE_PATH}/lease-client-0001`
      && entry.init?.method === "DELETE"
    )));
    expect(FakePeerConnection.latest?.closed).toBe(true);
  });

  test("answers each Live delegation exactly once and never reuses spent speech", async () => {
    const chatBodies: string[] = [];
    const errors: string[] = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      if (String(url) === "/api/voice/realtime/call") {
        return new Response("v=0\r\nanswer\r\n", {
          status: 200,
          headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-client-delegations" },
        });
      }
      if (String(url) === "/api/scoutbot/chat") {
        chatBodies.push(JSON.parse(String(init?.body)).body);
        return Response.json({ reply: { body: "Opened Blink." } });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => {}, addEventListener: () => {} }],
          }),
        },
      },
    });

    const call = await startScoutRealtimeVoiceCall({ onError: (message) => errors.push(message) });
    const events = FakeDataChannel.latest;
    events?.dispatchEvent(new Event("open"));

    events?.dispatchEvent(liveMessage({
      type: "session.input_transcript.delta",
      delta: "Open Blink in the Code Browser",
    }));
    const delegation = liveMessage({
      type: "session.delegation.created",
      delegation: { id: "delegation-dup", type: "delegation", target: "client" },
    });
    events?.dispatchEvent(delegation);
    // A redelivered delegation must not double-answer the same work.
    events?.dispatchEvent(liveMessage({
      type: "session.delegation.created",
      delegation: { id: "delegation-dup", type: "delegation", target: "client" },
    }));
    // Responses-owned work belongs to the API backend, never to this handler.
    events?.dispatchEvent(liveMessage({
      type: "session.delegation.created",
      delegation: { id: "delegation-responses", type: "delegation", target: "responses" },
    }));

    await waitFor(() => chatBodies.length === 1);
    await waitFor(() => (events?.sent.some((value) => (
      JSON.parse(value).delegation_id === "delegation-dup"
    )) ?? false));

    // A new ID without new speech waits for context, then asks for clarification
    // instead of submitting the same action again.
    events?.dispatchEvent(liveMessage({
      type: "session.delegation.created",
      delegation: { id: "delegation-2", type: "delegation", target: "client" },
    }));
    await waitFor(() => (events?.sent.some((value) => (
      JSON.parse(value).delegation_id === "delegation-2"
    )) ?? false));

    expect(chatBodies).toEqual([expect.stringContaining("Open Blink in the Code Browser")]);
    const answered = events?.sent
      .map((value) => JSON.parse(value))
      .filter((event) => typeof event.delegation_id === "string")
      .map((event) => event.delegation_id) ?? [];
    expect(answered).toEqual(["delegation-dup", "delegation-2"]);
    expect(errors).toEqual([]);
    await call.stop();
  });

  test("reports a Live session that ends on its own", async () => {
    const errors: string[] = [];
    const states: string[] = [];
    globalThis.fetch = (async (url) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      if (String(url) === "/api/voice/realtime/call") {
        return new Response("v=0\r\nanswer\r\n", {
          status: 200,
          headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-client-closed" },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => {}, addEventListener: () => {} }],
          }),
        },
      },
    });

    const call = await startScoutRealtimeVoiceCall({
      onError: (message) => errors.push(message),
      onState: (state) => states.push(state),
    });
    const events = FakeDataChannel.latest;
    events?.dispatchEvent(new Event("open"));
    events?.dispatchEvent(liveMessage({ type: "session.closed", reason: "expired" }));

    await waitFor(() => states.includes("ended"));
    expect(errors).toEqual([expect.stringContaining("session limit")]);
    await call.stop();
  });

  test("does not report an ended call until its host lease release completes", async () => {
    let resolveRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const states: string[] = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      if (String(url) === "/api/voice/realtime/call") {
        return new Response("v=0\r\nanswer\r\n", {
          status: 200,
          headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-client-0002" },
        });
      }
      if (init?.method === "DELETE") {
        await releaseGate;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => {}, addEventListener: () => {} }],
          }),
        },
      },
    });

    const call = await startScoutRealtimeVoiceCall({ onState: (state) => states.push(state) });
    const stopping = call.stop();
    await Promise.resolve();
    expect(states.at(-1)).toBe("live");

    resolveRelease();
    await stopping;
    expect(states.at(-1)).toBe("ended");
  });

  test("opens the selected speech input with echo suppression", async () => {
    const captureConstraints: MediaStreamConstraints[] = [];
    globalThis.fetch = (async (url) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      if (String(url) === "/api/voice/realtime/call") {
        return new Response("v=0\r\nanswer\r\n", {
          status: 200,
          headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-client-0003" },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          enumerateDevices: async () => [{
            kind: "audioinput",
            deviceId: "external-mic",
            groupId: "desk",
            label: "External Mic",
            toJSON: () => ({}),
          }],
          getUserMedia: async (constraints: MediaStreamConstraints) => {
            captureConstraints.push(constraints);
            return {
              getTracks: () => [{ stop: () => {}, addEventListener: () => {} }],
              getAudioTracks: () => [{ label: "External Mic", contentHint: "" }],
            };
          },
        },
      },
    });

    const call = await startScoutRealtimeVoiceCall({ inputDeviceName: "External Mic" });
    expect(captureConstraints).toEqual([{
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        deviceId: { exact: "external-mic" },
      },
    }]);
    await call.stop();
  });

  test("checks the host setting before opening the microphone", async () => {
    let mediaRequests = 0;
    globalThis.fetch = (async (url) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) {
        return Response.json({
          enabled: false,
          configuredEnabled: false,
          source: "settings",
          locked: false,
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            mediaRequests += 1;
            return { getTracks: () => [] };
          },
        },
      },
    });

    await expect(startScoutRealtimeVoiceCall()).rejects.toThrow("Settings → Voice");
    expect(mediaRequests).toBe(0);
    expect(FakePeerConnection.latest).toBeNull();
  });

  test("cancels promptly while microphone permission is still resolving", async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    const mediaPromise = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    });
    let trackStops = 0;
    let fetchCalls = 0;
    let mediaRequested = false;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      fetchCalls += 1;
      return new Response("unexpected");
    }) as unknown as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => {
        mediaRequested = true;
        return mediaPromise;
      } } },
    });
    const controller = new AbortController();
    const callPromise = startScoutRealtimeVoiceCall({ signal: controller.signal });
    await waitFor(() => mediaRequested);

    controller.abort();
    await expect(callPromise).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
    resolveMedia({
      getTracks: () => [{ stop: () => { trackStops += 1; } }],
    } as unknown as MediaStream);
    await waitFor(() => trackStops === 1);

    expect(fetchCalls).toBe(0);
    expect(FakePeerConnection.latest?.closed).toBe(true);
  });

  test("aborts the SDP request and cleans up microphone tracks", async () => {
    let trackStops = 0;
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = (async (url, init) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{
              stop: () => { trackStops += 1; },
              addEventListener: () => {},
            }],
          }),
        },
      },
    });
    const controller = new AbortController();
    const callPromise = startScoutRealtimeVoiceCall({ signal: controller.signal });
    await waitFor(() => Boolean(requestSignal));

    controller.abort();
    await expect(callPromise).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
    expect(requestSignal?.aborted).toBe(true);
    expect(trackStops).toBe(1);
    expect(FakePeerConnection.latest?.closed).toBe(true);
  });

  test("releases the lease when cancel lands during SDP answer body-read", async () => {
    let bodyReadStarted = false;
    let released = false;
    let trackStops = 0;
    globalThis.fetch = (async (url, init) => {
      if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
      if (String(url).startsWith(SCOUT_REALTIME_VOICE_LEASE_PATH) && init?.method === "DELETE") {
        released = true;
        return new Response(null, { status: 204 });
      }
      bodyReadStarted = true;
      return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
        status: 200,
        headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-body-read" },
      });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{
              stop: () => { trackStops += 1; },
              addEventListener: () => {},
            }],
          }),
        },
      },
    });
    const controller = new AbortController();
    const callPromise = startScoutRealtimeVoiceCall({ signal: controller.signal });
    await waitFor(() => bodyReadStarted);

    controller.abort();
    await expect(callPromise).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
    await waitFor(() => released);
    expect(trackStops).toBe(1);
    expect(FakePeerConnection.latest?.closed).toBe(true);
  });
});

function enabledSettingsResponse(): Response {
  return Response.json({
    enabled: true,
    configuredEnabled: true,
    source: "settings",
    locked: false,
  });
}

function liveMessage(payload: unknown): Event {
  return Object.assign(new Event("message"), { data: JSON.stringify({start_ms:0,end_ms:1000,offset_ms:1000,...(payload as object)}) });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true");
}

function installCallFixture(chat?: (init?: RequestInit) => Promise<Response>) {
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {}, addEventListener() {} }] }),
  } } });
  globalThis.fetch = (async (url, init) => {
    if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
    if (String(url) === "/api/voice/realtime/call") return new Response("v=0\r\nanswer\r\n", {headers:{[SCOUT_REALTIME_VOICE_LEASE_HEADER]:"lease-lifecycle-1","x-openscout-live-session-id":"live_test"}});
    if (String(url) === "/api/scoutbot/chat") return chat ? chat(init) : Response.json({reply:{body:"Done"}});
    return new Response(null,{status:204});
  }) as typeof fetch;
}

test("transport open is not readiness; greeting follows exactly one provider start", async () => {
  installCallFixture(); FakePeerConnection.startSession = false;
  const states: string[] = [];
  const call = await startScoutRealtimeVoiceCall({onState:s=>states.push(s)});
  const events = FakeDataChannel.latest!; events.dispatchEvent(new Event("open"));
  expect(states).toEqual(["connecting"]); expect(events.sent).toEqual([]);
  events.dispatchEvent(liveMessage({type:"session.started",session:{id:"live_test"}}));
  events.dispatchEvent(liveMessage({type:"session.started",session:{id:"live_test"}}));
  expect(states).toEqual(["connecting","live"]);
  expect(events.sent.map(value => JSON.parse(value))).toHaveLength(1);
  await call.stop();
});

test("provider startup error closes the call without announcing live", async () => {
  installCallFixture(); FakePeerConnection.startSession = false;
  const states: string[] = []; const errors: string[] = [];
  const call = await startScoutRealtimeVoiceCall({onState:s=>states.push(s),onError:e=>errors.push(e)});
  FakeDataChannel.latest!.dispatchEvent(liveMessage({type:"error",error:{message:"start rejected"}}));
  await call.stop(); expect(states).not.toContain("live"); expect(errors).toContain("start rejected");
  expect(FakePeerConnection.latest?.closed).toBe(true);
});

test("missing start event is bounded and releases the call", async () => {
  installCallFixture(); FakePeerConnection.startSession = false;
  const errors: string[] = [];
  const call = await startScoutRealtimeVoiceCall({onError:e=>errors.push(e)});
  await new Promise(resolve => setTimeout(resolve, 15100));
  await call.stop(); expect(errors).toContain("Live session did not become ready in time.");
  expect(FakePeerConnection.latest?.closed).toBe(true);
}, 20000);

test("missing final event reports unconfirmed usage after bounded resource cleanup", async () => {
  installCallFixture(); FakeDataChannel.acknowledgeClose = false;
  const errors: string[] = []; const traces: string[] = [];
  const call = await startScoutRealtimeVoiceCall({onError:e=>errors.push(e),onTrace:e=>traces.push(e.label)});
  await call.stop();
  expect(traces).toContain("Live finalization unconfirmed");
  expect(errors).toEqual([expect.stringContaining("final usage is unconfirmed")]);
  expect(FakePeerConnection.latest?.closed).toBe(true);
}, 7000);

test.each(["automatic", "explicit"])("%s close invalidates a delayed ask reply and undispatched delegation", async (mode) => {
  let resolveChat!: (response: Response) => void; let calls = 0; let effects = 0; let signal: AbortSignal | undefined;
  installCallFixture(async init => { calls++; signal = init?.signal ?? undefined; return new Promise(resolve=>{resolveChat=resolve;}); });
  const call = await startScoutRealtimeVoiceCall({onScoutbotReply:() => { effects++; return {agentRequests:{requested:1,sent:1,failed:0}}; }});
  const events = FakeDataChannel.latest!;
  events.dispatchEvent(liveMessage({type:"session.input_transcript.delta",delta:"Ask A to deploy"}));
  events.dispatchEvent(liveMessage({type:"session.delegation.created",delegation:{id:"first",target:"client"}}));
  await waitFor(()=>calls===1);
  events.dispatchEvent(liveMessage({type:"session.delegation.created",delegation:{id:"second",target:"client"}}));
  if (mode === "automatic") events.dispatchEvent(liveMessage({type:"session.closed",reason:"remote_hangup",usage:{seconds:5}}));
  else void call.stop();
  resolveChat(Response.json({reply:{body:'```scout-ui\n{"type":"ask-agent","targetLabel":"A","body":"deploy"}\n```'}}));
  await call.stop(); await new Promise(resolve=>setTimeout(resolve,300));
  expect(signal?.aborted).toBe(true); expect(calls).toBe(1); expect(effects).toBe(0);
});

test("append rejection is correlated and never treated as speech completion", async () => {
  installCallFixture(); const errors: string[] = [];
  const call = await startScoutRealtimeVoiceCall({onError:e=>errors.push(e)});
  const events = FakeDataChannel.latest!; const greeting = JSON.parse(events.sent[0]!);
  events.dispatchEvent(liveMessage({type:"error",client_event_id:greeting.event_id,error:{message:"append rejected"}}));
  expect(errors).toContain("append rejected"); await call.stop();
});

test.each([
  {requested:2,sent:2,failed:0,unknown:0},
  {requested:2,sent:0,failed:2,unknown:0},
  {requested:2,sent:1,failed:1,unknown:0},
  {requested:2,sent:1,failed:0,unknown:1},
])("long multilingual prose cannot hide delivery categories: %p", async (outcome) => {
  installCallFixture(async () => Response.json({reply:{body:"Everything succeeded. 中文🙂 ".repeat(1000)+'```scout-ui\n{"type":"ask-agent","targetLabel":"A","body":"check"}\n```'}}));
  const call = await startScoutRealtimeVoiceCall({onScoutbotReply:()=>({agentRequests:outcome})});
  const events = FakeDataChannel.latest!;
  events.dispatchEvent(liveMessage({type:"session.input_transcript.delta",delta:"Ask A to check"}));
  events.dispatchEvent(liveMessage({type:"session.delegation.created",delegation:{id:"failed-send",target:"client"}}));
  await waitFor(()=>events.sent.some(value=>JSON.parse(value).delegation_id==="failed-send"));
  const result = events.sent.map(value=>JSON.parse(value)).find(value=>value.delegation_id==="failed-send");
  expect(result.content).toContain(`${outcome.sent} of ${outcome.requested} requests sent automatically; ${outcome.failed} failed; ${outcome.unknown} unconfirmed.`); expect(result.content).not.toContain("Everything succeeded");
  expect(new TextEncoder().encode(result.content).length).toBeLessThanOrEqual(400); await call.stop();
});

test("armed mute is applied before tracks attach and setup controls stay live", async () => {
  const track = { enabled: true, stop() {}, addEventListener() {} };
  let attachedEnabled: boolean | undefined;
  let controls: { setMicMuted: (value: boolean) => void; setPlaybackMuted: (value: boolean) => void } | undefined;
  class MutedPeer extends FakePeerConnection {
    addTrack(): RTCRtpSender { attachedEnabled = track.enabled; return {} as RTCRtpSender; }
  }
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: MutedPeer });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  } });
  globalThis.fetch = (async (url) => {
    if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return enabledSettingsResponse();
    return new Response("v=0\r\nanswer\r\n", { status: 200, headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-muted" } });
  }) as typeof fetch;
  const call = await startScoutRealtimeVoiceCall({
    getAudioMuteState: () => ({ micMuted: true, playbackMuted: true }),
    onAudioControls: (next) => { controls = next; },
  });
  expect(attachedEnabled).toBe(false);
  controls!.setMicMuted(false);
  expect(track.enabled).toBe(true);
  await call.stop();
});
