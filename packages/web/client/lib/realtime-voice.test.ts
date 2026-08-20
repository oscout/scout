import { afterEach, describe, expect, test } from "bun:test";

import { startScoutRealtimeVoiceCall } from "./realtime-voice.ts";
import {
  SCOUT_REALTIME_VOICE_LEASE_HEADER,
  SCOUT_REALTIME_VOICE_LEASE_PATH,
} from "../../shared/realtime-voice.ts";

const originalFetch = globalThis.fetch;
const originalPeerConnection = globalThis.RTCPeerConnection;
const originalAudio = globalThis.Audio;
const originalNavigator = globalThis.navigator;

class FakeDataChannel extends EventTarget {
  static latest: FakeDataChannel | null = null;

  readonly sent: string[] = [];
  readyState: RTCDataChannelState = "open";

  constructor() {
    super();
    FakeDataChannel.latest = this;
  }

  send(value: string): void {
    this.sent.push(value);
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;

  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  closed = false;

  constructor() {
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

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
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
  FakePeerConnection.latest = null;
});

describe("Scout Realtime voice client", () => {
  test("routes a realtime ask_scoutbot function call through the existing Scoutbot chat loop", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const replies: string[] = [];
    const trace: string[] = [];
    globalThis.fetch = (async (url, init) => {
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
    expect(events?.sent.slice(0, 2).map((value) => JSON.parse(value))).toEqual([
      {
        type: "session.update",
        session: {
          type: "realtime",
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
          },
        },
      },
      expect.objectContaining({ type: "response.create" }),
    ]);
    currentRoute = { view: "fleet" };
    events?.dispatchEvent(Object.assign(new Event("message"), {
      data: JSON.stringify({
        type: "response.done",
        response: {
          output: [{
            type: "function_call",
            name: "ask_scoutbot",
            call_id: "call-1",
            arguments: JSON.stringify({ request: "What is happening in the fleet?" }),
          }],
        },
      }),
    }));

    await waitFor(() => fetchCalls.length === 2 && replies.length === 1);

    expect(new Headers(fetchCalls[0]?.init?.headers).get("content-type")).toBe("application/sdp");
    expect(fetchCalls[1]).toMatchObject({
      url: "/api/scoutbot/chat",
      init: {
        method: "POST",
        body: JSON.stringify({
          body: "What is happening in the fleet?",
          route: { view: "fleet" },
          uiContext: { host: "macos" },
        }),
      },
    });
    expect(replies).toEqual([expect.stringContaining("The fleet is healthy.")]);
    expect(trace).toEqual(expect.arrayContaining([
      "Scoutbot bridge ready",
      "Scoutbot is checking the control plane",
      "Scoutbot reply ready",
    ]));
    expect(events?.sent.map((value) => JSON.parse(value))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "response.create" }),
      expect.objectContaining({
        type: "conversation.item.create",
        item: expect.objectContaining({
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({
            ok: true,
            reply: "The fleet is healthy.",
            agentRequests: { requested: 1, sent: 1, failed: 0 },
          }),
        }),
      }),
      expect.objectContaining({
        type: "response.create",
        response: expect.objectContaining({
          instructions: expect.stringContaining("was sent automatically"),
        }),
      }),
    ]));
    await call.stop();
    await waitFor(() => fetchCalls.some((entry) => (
      entry.url === `${SCOUT_REALTIME_VOICE_LEASE_PATH}/lease-client-0001`
      && entry.init?.method === "DELETE"
    )));
    expect(FakePeerConnection.latest?.closed).toBe(true);
  });

  test("queues a Scoutbot tool reply behind the session's current spoken response", async () => {
    let resolveChat!: () => void;
    const chatGate = new Promise<void>((resolve) => {
      resolveChat = resolve;
    });
    const errors: string[] = [];
    globalThis.fetch = (async (url) => {
      if (String(url) === "/api/voice/realtime/call") {
        return new Response("v=0\r\nanswer\r\n", {
          status: 200,
          headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-client-queued" },
        });
      }
      if (String(url) === "/api/scoutbot/chat") {
        await chatGate;
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
    events?.dispatchEvent(Object.assign(new Event("message"), {
      data: JSON.stringify({
        type: "response.done",
        response: {
          output: [{
            type: "function_call",
            name: "ask_scoutbot",
            call_id: "call-queued",
            arguments: JSON.stringify({ request: "Open Blink in the Code Browser" }),
          }],
        },
      }),
    }));
    events?.dispatchEvent(Object.assign(new Event("message"), {
      data: JSON.stringify({ type: "response.created" }),
    }));
    resolveChat();

    await waitFor(() => events?.sent.some((value) => (
      JSON.parse(value).item?.call_id === "call-queued"
    )) ?? false);
    expect(events?.sent.map((value) => JSON.parse(value)).filter((event) => event.type === "response.create")).toHaveLength(1);

    events?.dispatchEvent(Object.assign(new Event("message"), {
      data: JSON.stringify({ type: "response.done", response: { output: [] } }),
    }));
    await waitFor(() => (
      events?.sent.map((value) => JSON.parse(value)).filter((event) => event.type === "response.create").length === 2
    ));
    expect(errors).toEqual([]);
    await call.stop();
  });

  test("does not report an ended call until its host lease release completes", async () => {
    let resolveRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const states: string[] = [];
    globalThis.fetch = (async (url, init) => {
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

  test("uses close-talk noise reduction for a headset while preserving interruption", async () => {
    globalThis.fetch = (async (url) => {
      if (String(url) === "/api/voice/realtime/call") {
        return new Response("v=0\r\nanswer\r\n", {
          status: 200,
          headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: "lease-client-0004" },
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
            getAudioTracks: () => [{ label: "Art's AirPods", contentHint: "" }],
          }),
        },
      },
    });

    const call = await startScoutRealtimeVoiceCall({ inputDeviceName: "Art's AirPods" });
    const events = FakeDataChannel.latest;
    events?.dispatchEvent(new Event("open"));

    expect(JSON.parse(events?.sent[0] ?? "null")).toEqual(expect.objectContaining({
      type: "session.update",
      session: expect.objectContaining({
        audio: {
          input: expect.objectContaining({
            noise_reduction: { type: "near_field" },
            turn_detection: expect.objectContaining({ interrupt_response: true }),
          }),
        },
      }),
    }));
    await call.stop();
  });

  test("cancels promptly while microphone permission is still resolving", async () => {
    let resolveMedia!: (stream: MediaStream) => void;
    const mediaPromise = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    });
    let trackStops = 0;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    }) as unknown as typeof fetch;
    Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => mediaPromise } },
    });
    const controller = new AbortController();
    const callPromise = startScoutRealtimeVoiceCall({ signal: controller.signal });
    await Promise.resolve();

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
    globalThis.fetch = (async (_url, init) => {
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}
