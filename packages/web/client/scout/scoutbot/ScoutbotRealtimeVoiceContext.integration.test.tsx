import { afterEach, expect, mock, test } from "bun:test";
import { SCOUT_REALTIME_VOICE_CALL_PATH, SCOUT_REALTIME_VOICE_LEASE_HEADER, SCOUT_REALTIME_VOICE_LEASE_PATH, SCOUT_REALTIME_VOICE_SETTINGS_PATH } from "../../../shared/realtime-voice.ts";
// Real React effects/state, real context, real client. No endCall/stop mocks.
// @ts-expect-error Runtime entry instead of TS alias.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Runtime entry instead of TS alias.
const JSX = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Runtime entry instead of TS alias.
const JSXDev = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Runtime entry instead of TS alias.
const ReactDOM = await import("../../../node_modules/react-dom/client.js");
mock.module("react", () => React);
mock.module("react/jsx-runtime", () => JSX);
mock.module("react/jsx-dev-runtime", () => JSXDev);
mock.module("hudsonkit/flags", () => ({ useOptionalFlag: () => true }));
mock.module("../Provider.tsx", () => ({ useScout: () => ({ route: { view: "voice" }, applyScoutbotUiAction: () => {} }) }));
mock.module("../../lib/scout-voice.ts", () => ({ fetchScoutVoiceSettings: async () => ({ settings: { inputDeviceName: null } }) }));
const { ScoutbotRealtimeVoiceProvider, useScoutbotRealtimeVoice } = await import("./ScoutbotRealtimeVoiceContext.tsx");
const original = new Map<string, PropertyDescriptor | undefined>();
function globalValue(key: string, value: unknown) {
  if (!original.has(key)) original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let value: ReturnType<typeof useScoutbotRealtimeVoice>;
let root: ReturnType<typeof ReactDOM.createRoot> | undefined;
let releases: Array<ReturnType<typeof deferred<Response>>>;
let created: number, trackStops: number, audioPauses: number, peerCloses: number, closeMessages: number;
let failSetup = false, autoRelease = false;
class Channel extends EventTarget {
  readyState = "open";
  send(data: string) {
    if (JSON.parse(data).type === "session.close") {
      closeMessages++;
      queueMicrotask(() => this.message({ type: "session.closed", usage: { seconds: 2 } }));
    }
  }
  message(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
}
class Peer extends EventTarget {
  static latest: Peer;
  channel = new Channel(); iceGatheringState = "complete"; connectionState = "new";
  localDescription: unknown; onconnectionstatechange?: () => void;
  constructor() { super(); Peer.latest = this; }
  addTrack() { return {}; }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "fixture-offer" }; }
  async setLocalDescription(offer: unknown) { this.localDescription = offer; }
  async setRemoteDescription() {
    if (failSetup) throw new Error("SDP rejected");
    this.connectionState = "connected"; this.onconnectionstatechange?.();
    this.channel.message({ type: "session.started", session: { id: "fixture-session" } });
  }
  close() { peerCloses++; }
}
async function mount() {
  releases = []; created = trackStops = audioPauses = peerCloses = closeMessages = 0; failSetup = autoRelease = false;
  // Probe renders null: only React DOM's root/event/focus host contract is needed.
  // This is a deterministic in-memory host, not a browser or a second UI stack.
  const win = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, location: { href: "http://fixture/voice" } });
  const doc = Object.assign(new EventTarget(), { nodeType: 9, defaultView: win, activeElement: null, documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml" } });
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", nodeName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: doc, textContent: "" });
  globalValue("window", win); globalValue("document", doc); globalValue("IS_REACT_ACT_ENVIRONMENT", true);
  globalValue("RTCPeerConnection", Peer);
  globalValue("Audio", class { autoplay = false; muted = false; srcObject = null; async play() {} pause() { audioPauses++; } });
  globalValue("navigator", { mediaDevices: { getUserMedia: async () => {
    const track = { enabled: true, stop: () => { trackStops++; } }; return { getTracks: () => [track] };
  } } });
  globalValue("fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url) === SCOUT_REALTIME_VOICE_SETTINGS_PATH) return Response.json({ enabled: true, configuredEnabled: true, source: "settings", locked: false });
    if (String(url) === "/api/scoutbot/session") return Response.json({ session: { id: "chat", messages: [] }, sessions: [], config: { model: "fixture" } });
    if (String(url) === SCOUT_REALTIME_VOICE_CALL_PATH) {
      created++; return new Response("fixture-answer", { headers: { [SCOUT_REALTIME_VOICE_LEASE_HEADER]: `lease-${created}` } });
    }
    if (String(url).startsWith(SCOUT_REALTIME_VOICE_LEASE_PATH + "/") && init?.method === "DELETE") {
      const release = deferred<Response>(); releases.push(release);
      if (autoRelease) release.resolve(new Response(null, { status: 204 }));
      return release.promise;
    }
    throw new Error(`Unexpected external request: ${String(url)}`);
  });
  function Probe() { value = useScoutbotRealtimeVoice(); return null; }
  root = ReactDOM.createRoot(container as unknown as Element);
  await React.act(async () => { root!.render(React.createElement(ScoutbotRealtimeVoiceProvider, null, React.createElement(Probe))); await tick(); });
  expect(value.enabled).toBe(true);
}
afterEach(async () => {
  autoRelease = true;
  for (const release of releases ?? []) release.resolve(new Response(null, { status: 204 }));
  if (root) { await React.act(async () => { await value.endCall(); root!.unmount(); }); root = undefined; }
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  original.clear();
});
async function start() { await React.act(async () => { await value.startCall(); }); }
async function beginEnd() {
  let result!: Promise<boolean>;
  await React.act(async () => { result = value.endCall(); await tick(); });
  return { result };
}
async function failRelease(index: number, result: Promise<boolean>, httpFailure = false) {
  let allowed!: boolean;
  await React.act(async () => {
    if (httpFailure) releases[index]!.resolve(new Response("retry later", { status: 503 }));
    else releases[index]!.reject(new Error("release failed"));
    allowed = await result;
  });
  expect(allowed).toBe(false); // Actual page requires true before selecting Local.
  expect(value.leaseId).toBe("lease-1"); expect(value.state).toBe("error");
  expect(value.trace.some(event => event.detail === "Microphone and host lease released")).toBe(false);
  await start(); expect(created).toBe(1); // Context enforces new-call guard itself.
}
test("failed/repeated/concurrent retries block Local and new calls until actual release", async () => {
  await mount(); await start(); expect(value.state).toBe("live");
  const first = await beginEnd(); expect(releases).toHaveLength(1);
  const concurrentFailure = value.endCall(); expect(concurrentFailure).toBe(first.result);
  await failRelease(0, first.result); expect(await concurrentFailure).toBe(false);
  const second = await beginEnd(); expect(releases).toHaveLength(2); await failRelease(1, second.result, true);
  let left!: Promise<boolean>, right!: Promise<boolean>; let settled = false;
  await React.act(async () => { left = value.endCall(); right = value.endCall(); void left.then(() => { settled = true; }); await tick(); });
  expect(left).toBe(right); expect(releases).toHaveLength(3); expect(settled).toBe(false);
  expect(value.leaseId).toBe("lease-1"); await start(); expect(created).toBe(1);
  await React.act(async () => { releases[2]!.resolve(new Response(null, { status: 204 })); expect(await left).toBe(true); expect(await right).toBe(true); });
  expect(value.leaseId).toBeNull(); expect(value.state).toBe("ended");
  expect(trackStops).toBe(1); expect(audioPauses).toBe(1); expect(peerCloses).toBe(1); expect(closeMessages).toBe(1);
  autoRelease = true; await start(); expect(created).toBe(2);
});
test("automatic transport close and explicit close share release and retain failed ownership", async () => {
  await mount(); await start(); let ending!: Promise<boolean>;
  await React.act(async () => { Peer.latest.connectionState = "failed"; Peer.latest.onconnectionstatechange?.(); ending = value.endCall(); await tick(); });
  expect(releases).toHaveLength(1); await failRelease(0, ending);
  const retry = await beginEnd();
  await React.act(async () => { releases[1]!.resolve(new Response(null, { status: 204 })); expect(await retry.result).toBe(true); });
  expect(value.leaseId).toBeNull(); expect(trackStops).toBe(1);
});
test("setup failure publishes lease ownership before rejecting, so cleanup stays retryable", async () => {
  await mount(); failSetup = true; let starting!: Promise<void>;
  await React.act(async () => { starting = value.startCall(); await tick(); });
  expect(releases).toHaveLength(1);
  await React.act(async () => { releases[0]!.reject(new Error("release failed")); await starting; });
  expect(value.leaseId).toBe("lease-1");
  const retry = await beginEnd(); expect(releases).toHaveLength(2); await failRelease(1, retry.result);
  const success = await beginEnd();
  await React.act(async () => { releases[2]!.resolve(new Response(null, { status: 204 })); expect(await success.result).toBe(true); });
  expect(value.leaseId).toBeNull(); expect(trackStops).toBe(1);
});


test("an automatic close failure alone retains lease and a genuine retry handle", async () => {
  await mount(); await start();
  await React.act(async () => {
    Peer.latest.connectionState = "failed"; Peer.latest.onconnectionstatechange?.(); await tick();
    releases[0]!.reject(new Error("release failed")); await tick();
  });
  expect(value.state).toBe("error"); expect(value.leaseId).toBe("lease-1");
  await start(); expect(created).toBe(1);
  const retry = await beginEnd(); expect(releases).toHaveLength(2);
  await React.act(async () => { releases[1]!.resolve(new Response(null, { status: 204 })); expect(await retry.result).toBe(true); });
  expect(value.leaseId).toBeNull(); expect(trackStops).toBe(1);
});
