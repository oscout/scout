import { LiveDelegationContext, boundedLiveCommentary } from "./live-delegation.ts";
import {
  SCOUT_REALTIME_SCOUTBOT_CHAT_PATH,
  SCOUT_REALTIME_VOICE_CALL_PATH,
  SCOUT_REALTIME_VOICE_LEASE_HEADER,
  SCOUT_REALTIME_VOICE_LEASE_PATH,
} from "../../shared/realtime-voice.ts";
import { extractScoutbotUiActions, stripScoutbotUiFences } from "./scoutbot.ts";
import { fetchScoutRealtimeVoiceSettings } from "./realtime-voice-settings.ts";

const REALTIME_VOICE_HEARTBEAT_MS = 25_000;

export type ScoutRealtimeVoiceConnectionState = "connecting" | "live" | "ended" | "error";

export type ScoutRealtimeVoiceCall = {
  /** Host-local admission lease for native stop reconciliation. */
  leaseId: string;
  /** Resolves only after the host-local concurrency lease has been released. */
  stop: () => Promise<void>;
};

export type ScoutRealtimeVoiceTraceEvent = {
  id: string;
  at: number;
  kind?: ScoutRealtimeVoiceTraceKind;
  label: string;
  detail?: string;
};

export type ScoutRealtimeVoiceTraceKind = "voice" | "scoutbot" | "navigation" | "agent" | "error";

export type ScoutRealtimeVoiceReplyActions = {
  agentRequests: {
    requested: number;
    sent: number;
    failed: number;
    unknown?: number;
  };
};

type ScoutbotChatResult = {
  reply?: { body?: unknown };
};

export async function startScoutRealtimeVoiceCall(callbacks: {
  onState?: (state: ScoutRealtimeVoiceConnectionState) => void;
  onError?: (message: string) => void;
  onScoutbotReply?: (
    body: string,
    isCurrent: () => boolean,
  ) => ScoutRealtimeVoiceReplyActions | Promise<ScoutRealtimeVoiceReplyActions>;
  onTrace?: (event: ScoutRealtimeVoiceTraceEvent) => void;
  /** Read the route at the moment Scoutbot handles a turn, not only when the call started. */
  getRoute?: () => unknown;
  /** Host-specific navigation capabilities for honest voice guidance. */
  getUiContext?: () => unknown;
  route?: unknown;
  /** Native Scout input preference, matched to WebKit's device labels when available. */
  inputDeviceName?: string | null;
  signal?: AbortSignal;
} = {}): Promise<ScoutRealtimeVoiceCall> {
  throwIfAborted(callbacks.signal);
  if (!globalThis.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support realtime audio calls.");
  }

  // Resolve the host gate before asking for microphone access. Settings can
  // change in another window, and a stale footer must never flash the privacy
  // indicator merely to discover that calls are disabled server-side.
  const settings = await fetchScoutRealtimeVoiceSettings(callbacks.signal);
  if (!settings.enabled) {
    throw new Error("Live voice is off. Turn it on in Settings → Voice before starting a call.");
  }
  throwIfAborted(callbacks.signal);

  callbacks.onState?.("connecting");
  const peerConnection = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  const setupController = new AbortController();
  const setupSignal = setupController.signal;
  let stopped = false;
  let mediaStream: MediaStream | null = null;
  let leaseId: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatFailures = 0;
  let traceSequence = 0;

  const trace = (
    label: string,
    detail?: string,
    kind: ScoutRealtimeVoiceTraceKind = "voice",
  ) => {
    traceSequence += 1;
    callbacks.onTrace?.({
      id: `voice-${traceSequence}`,
      at: Date.now(),
      kind,
      label,
      ...(detail ? { detail } : {}),
    });
  };

  let events: RTCDataChannel | null = null;
  let started = false;
  let sessionId: string | undefined;
  let usageSeconds: number | undefined;
  let finalReason: string | undefined;
  let finalized = false;
  let resolveFinal: () => void = () => {};
  const finalEvent = new Promise<void>(resolve => { resolveFinal = resolve; });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let delegationContext: LiveDelegationContext | undefined;
  const pendingAppends = new Map<string, ReturnType<typeof setTimeout>>();
  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    setupController.abort();
    callbacks.signal?.removeEventListener("abort", stopAfterAbort);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    clearTimeout(startupTimer);
    delegationContext?.stop();
    for (const timer of pendingAppends.values()) clearTimeout(timer);
    pendingAppends.clear();
    // Stop capturing immediately; keep the receiver alive for final usage.
    mediaStream?.getTracks().forEach((track) => { track.enabled = false; });
    const leaseToRelease = leaseId;
    leaseId = null;
    stopPromise = (async () => {
      if (!finalized && events?.readyState === "open") {
        try { events.send(JSON.stringify({ type: "session.close", event_id: crypto.randomUUID() })); } catch {}
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([finalEvent, new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 4000); })]);
        clearTimeout(closeTimer);
      }
      trace(finalized ? "Live session finalized" : "Live finalization unconfirmed", JSON.stringify({ sessionId, reason: finalReason, usageSeconds }));
      mediaStream?.getTracks().forEach((track) => track.stop());
      audio.pause(); audio.srcObject = null; peerConnection.close();
      if (leaseToRelease) await releaseRealtimeVoiceLease(leaseToRelease, { state: finalized ? "confirmed" : "unconfirmed", reason: finalReason, seconds: usageSeconds });
      if (!finalized && sessionId) callbacks.onError?.("Audio stopped; provider final usage is unconfirmed. Scout will attempt server cleanup.");
      callbacks.onState?.("ended");
    })();
    return stopPromise;
  };
  const stopQuietly = () => {
    void stop().catch((error) => {
      callbacks.onError?.(
        error instanceof Error ? error.message : "Could not release the realtime voice lease.",
      );
      callbacks.onState?.("error");
    });
  };
  const stopAfterAbort = () => { stopQuietly(); };
  callbacks.signal?.addEventListener("abort", stopAfterAbort, { once: true });

  peerConnection.ontrack = ({ streams }) => {
    const stream = streams[0];
    if (!stream || stopped) return;
    const [track] = stream.getAudioTracks();
    if (track) {
      track.addEventListener("ended", () => {
        if (!stopped) { callbacks.onError?.("Realtime voice audio ended unexpectedly."); stopQuietly(); }
      });
    }
    audio.srcObject = stream;
    void audio.play()
      .catch(() => {
        if (stopped) return;
        callbacks.onError?.("Browser playback was blocked. Interact with the page, then start the call again.");
        stopQuietly();
      });
  };
  peerConnection.onconnectionstatechange = () => {
    if (stopped) return;
    if (peerConnection.connectionState === "connected") {
      trace("Audio transport connected", "Waiting for Live session readiness");
    } else if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
      callbacks.onError?.("Realtime voice connection ended unexpectedly.");
      stopQuietly();
    }
  };

  try {
    mediaStream = await acquireRealtimeVoiceMediaStream(
      callbacks.inputDeviceName,
      setupSignal,
    );
    throwIfAborted(setupSignal);
    for (const track of mediaStream.getTracks()) {
      peerConnection.addTrack(track, mediaStream);
    }

    events = peerConnection.createDataChannel("oai-events");
    const sendLiveEvent = (payload: unknown): boolean => {
      if (stopped || !started || events?.readyState !== "open") return false;
      const eventId = crypto.randomUUID();
      try {
        pendingAppends.set(eventId, setTimeout(() => {
          pendingAppends.delete(eventId);
          if (!stopped) callbacks.onError?.("Live update acceptance was not confirmed; check the activity log.");
        }, 10000));
        events.send(JSON.stringify({ ...(payload as object), event_id: eventId }));
        return true;
      } catch {
        clearTimeout(pendingAppends.get(eventId)); pendingAppends.delete(eventId);
        callbacks.onError?.("Live voice events channel closed unexpectedly."); stopQuietly();
        return false;
      }
    };
    delegationContext = new LiveDelegationContext(
      task => fulfillScoutLiveDelegation({ delegationId: task.id, request: task.request, signal: task.signal,
        isCurrent: task.isCurrent, route: callbacks.getRoute?.() ?? callbacks.route,
        uiContext: callbacks.getUiContext?.(), onReply: callbacks.onScoutbotReply, onTrace: trace, send: sendLiveEvent }),
      id => sendScoutLiveCommentary({ delegationId: id, send: sendLiveEvent }, "No new complete request could be identified. Ask the operator to clarify; do not repeat earlier work."),
    );
    const failTransport = () => { if (!stopped) { callbacks.onError?.("Live voice events channel closed unexpectedly."); stopQuietly(); } };
    events.addEventListener("error", failTransport);
    events.addEventListener("close", failTransport);
    events.addEventListener("message", (event) => {
      const payload = parseLiveEvent(event.data);
      if (!payload) return;
      if (payload.client_event_id && pendingAppends.has(payload.client_event_id)) {
        clearTimeout(pendingAppends.get(payload.client_event_id)); pendingAppends.delete(payload.client_event_id);
        trace(payload.type === "error" ? "Live update rejected" : "Live update accepted", payload.client_event_id);
      }
      if (payload.usage && typeof payload.usage.seconds === "number" && Number.isFinite(payload.usage.seconds)) usageSeconds = payload.usage.seconds;
      if (typeof payload.session?.id === "string") sessionId = payload.session.id;
      if (payload.type === "session.closed") {
        finalized = true; finalReason = payload.reason; resolveFinal();
        if (!stopped) {
          const message = liveSessionCloseError(payload.reason);
          if (message) callbacks.onError?.(message);
          stopQuietly();
        }
        return;
      }
      if (stopped) return;
      if (payload.type === "error") {
        callbacks.onError?.(payload.message ?? "OpenAI Live reported an error.");
        if (!started || !payload.client_event_id) stopQuietly();
        return;
      }
      if (payload.type === "session.started") {
        if (started) return;
        started = true; clearTimeout(startupTimer);
        callbacks.onState?.("live"); trace("Live session ready", sessionId);
        sendLiveEvent({ type: "session.instructions.append", delegation_id: null,
          content: "Open with one brief spoken greeting: you are Scoutbot, you can check the fleet and coordinate through Scout, and ask what the operator would like to work on." });
        return;
      }
      if (!started) return;
      if (payload.type === "session.input_transcript.delta" || payload.type === "session.output_transcript.delta") {
        delegationContext?.transcript(payload.type === "session.input_transcript.delta" ? "user" : "assistant", payload.delta ?? "", payload.start_ms ?? NaN, payload.end_ms ?? NaN);
      } else if (payload.type === "session.delegation.created" && payload.delegation?.target === "client") {
        delegationContext?.delegation(payload.delegation.id, payload.offset_ms ?? 0);
      }
    });
    startupTimer = setTimeout(() => {
      if (!started && !stopped) { callbacks.onError?.("Live session did not become ready in time."); stopQuietly(); }
    }, 15000);

    const offer = await abortable(peerConnection.createOffer(), setupSignal);
    await abortable(peerConnection.setLocalDescription(offer), setupSignal);
    await waitForIceGathering(peerConnection, setupSignal);
    const offerSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
    if (!offerSdp) {
      throw new Error("Could not create a WebRTC offer.");
    }

    const response = await fetch(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
      },
      body: offerSdp,
      signal: setupSignal,
    });
    sessionId = response.headers.get("x-openscout-live-session-id") ?? sessionId;
    leaseId = response.headers.get(SCOUT_REALTIME_VOICE_LEASE_HEADER)?.trim() || null;
    const answerSdp = await abortable(response.text(), setupSignal);
    if (!response.ok) {
      throw new Error(readRealtimeCallError(answerSdp, response.status));
    }
    if (!leaseId) {
      throw new Error("Scout started the audio connection without a concurrency lease. Please try again.");
    }
    heartbeatTimer = setInterval(() => {
      if (!leaseId || stopped) return;
      const currentLeaseId = leaseId;
      void heartbeatRealtimeVoiceLease(currentLeaseId)
        .then((ok) => {
          if (stopped || currentLeaseId !== leaseId) return;
          if (ok) {
            heartbeatFailures = 0;
            return;
          }
          callbacks.onError?.("Realtime voice lost its server lease. Reconnect to continue safely.");
          stopQuietly();
        })
        .catch(() => {
          heartbeatFailures += 1;
          if (heartbeatFailures < 2 || stopped) return;
          callbacks.onError?.("Realtime voice could not renew its server lease. Check the connection and try again.");
          stopQuietly();
        });
    }, REALTIME_VOICE_HEARTBEAT_MS);
    await abortable(
      peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp }),
      setupSignal,
    );
    throwIfAborted(setupSignal);
    if (stopped) throw new Error("Live session ended during setup.");

    return { leaseId, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Commentary is capped at 500 tokens, and it is spoken rather than reasoned
 * over, so use a conservative UTF-8 byte ceiling for long answers
 * here instead of being silently rejected by the session.
 */


async function fulfillScoutLiveDelegation(input: {
  delegationId: string;
  request: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  route: unknown;
  uiContext?: unknown;
  onReply?: (
    body: string,
    isCurrent: () => boolean,
  ) => ScoutRealtimeVoiceReplyActions | Promise<ScoutRealtimeVoiceReplyActions>;
  onTrace: (label: string, detail?: string, kind?: ScoutRealtimeVoiceTraceKind) => void;
  send: (payload: unknown) => boolean;
}): Promise<void> {
  if (!input.isCurrent()) return;
  if (!input.request) {
    input.onTrace("Scoutbot request could not be read", undefined, "error");
    sendScoutLiveCommentary(
      input,
      "Scout did not catch that request clearly enough to look it up. Ask the operator to say it again.",
    );
    return;
  }

  input.onTrace("Scoutbot is checking the control plane", input.request, "scoutbot");
  try {
    const response = await fetch(SCOUT_REALTIME_SCOUTBOT_CHAT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: input.request, route: input.route, uiContext: input.uiContext }),
      signal: input.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(readScoutbotChatError(raw, response.status));
    }
    if (!input.isCurrent()) return;
    const parsed = JSON.parse(raw) as ScoutbotChatResult;
    const body = typeof parsed.reply?.body === "string" ? parsed.reply.body.trim() : "";
    if (!body) {
      throw new Error("Scoutbot returned an empty reply.");
    }

    const agentRequestCount = extractScoutbotUiActions(body)
      .filter((action) => action.type === "ask-agent")
      .length;
    const replyActions = input.onReply
      ? await input.onReply(body, input.isCurrent)
      : {
          agentRequests: {
            requested: agentRequestCount,
            sent: 0,
            failed: agentRequestCount,
          },
        };
    if (!input.isCurrent()) return;
    const spokenReply = stripScoutbotUiFences(body);
    input.onTrace("Scoutbot reply ready", undefined, "scoutbot");
    // Delivery outcome has to ride inside the spoken text now. With client
    // delegation there is no structured tool result the model can reason over,
    // so an unsaid failure would be reported as success.
    sendScoutLiveCommentary(
      input,
      replyActions.agentRequests.requested > 0 ? agentRequestSuffix(replyActions.agentRequests) : spokenReply,
    );
  } catch (error) {
    if (!input.isCurrent()) return;
    const message = error instanceof Error ? error.message : "Scoutbot could not complete the voice request.";
    input.onTrace("Scoutbot request failed", message, "error");
    sendScoutLiveCommentary(
      input,
      `Scout could not complete that live lookup. Tell the operator plainly: ${message}`,
    );
  }
}

function agentRequestSuffix(
  agentRequests: ScoutRealtimeVoiceReplyActions["agentRequests"],
): string {
  if (agentRequests.requested < 1) return "";
  const unknown = Math.max(agentRequests.unknown ?? 0, agentRequests.requested - agentRequests.sent - agentRequests.failed);
  return `${agentRequests.sent} of ${agentRequests.requested} requests sent automatically; ${agentRequests.failed} failed; ${unknown} unconfirmed. Check the activity log before retrying. Accepted work is not completed work.`;

}

function sendScoutLiveCommentary(
  input: { delegationId: string; send: (payload: unknown) => boolean },
  content: string,
): void {
  input.send({
    type: "session.commentary.append",
    delegation_id: input.delegationId,
    content: trimCommentary(content),
  });
}

function trimCommentary(content: string): string { return boundedLiveCommentary(content); }

function parseLiveEvent(value: unknown): {
  type?: string; message?: string; delta?: string; reason?: string;
  client_event_id?: string; start_ms?: number; end_ms?: number; offset_ms?: number;
  usage?: { seconds?: number }; session?: { id?: string };
  delegation?: { id: string; target: string };
} | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const string = (value: unknown) => typeof value === "string" ? value : undefined;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
    return { type: string(parsed.type), delta: string(parsed.delta), reason: string(parsed.reason),
      message: string(parsed.error?.message), client_event_id: string(parsed.client_event_id) ?? string(parsed.error?.event_id),
      start_ms: number(parsed.start_ms), end_ms: number(parsed.end_ms), offset_ms: number(parsed.offset_ms),
      usage: {seconds:number(parsed.usage?.seconds)}, session: {id:string(parsed.session?.id)},
      delegation: typeof parsed.delegation?.id === "string" && typeof parsed.delegation?.target === "string"
        ? {id:parsed.delegation.id,target:parsed.delegation.target} : undefined };
  } catch { return null; }
}

async function waitForIceGathering(peer: RTCPeerConnection, signal?: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await abortable(new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); signal?.removeEventListener("abort", aborted); };
    const changed = () => { if (peer.iceGatheringState === "complete") { finish(); resolve(); } };
    const aborted = () => { finish(); reject(abortReason(signal!)); };
    const timer = setTimeout(() => { finish(); reject(new Error("Audio connection discovery timed out.")); }, 8000);
    peer.addEventListener("icegatheringstatechange", changed); signal?.addEventListener("abort", aborted, { once: true });
    changed();
  }), signal);
}

/** A requested hangup is the expected ending; every other reason is reportable. */
function liveSessionCloseError(reason: string | undefined): string | null {
  switch (reason) {
    case "close_requested":
    case "remote_hangup":
      return null;
    case "expired":
      return "Live voice reached its session limit. Start a new call to continue.";
    case "content":
      return "Live voice ended the call on a safety filter.";
    case "connection_lost":
      return "Live voice lost its connection unexpectedly.";
    default:
      return reason ? `Live voice ended unexpectedly (${reason}).` : null;
  }
}

function readScoutbotChatError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
  } catch {
    // Fall back to a stable status message below.
  }
  return `Scoutbot could not complete the live lookup (HTTP ${status}).`;
}

function readRealtimeCallError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
  } catch {
    // Fall back to a stable, non-provider-specific browser error below.
  }
  return `Could not start realtime voice (HTTP ${status}).`;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function abortableMediaStream(
  promise: Promise<MediaStream>,
  signal?: AbortSignal,
): Promise<MediaStream> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<MediaStream>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (stream) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted || signal.aborted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        resolve(stream);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (!aborted) reject(error);
      },
    );
  });
}

const REALTIME_SPEECH_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

async function acquireRealtimeVoiceMediaStream(
  inputDeviceName: string | null | undefined,
  signal?: AbortSignal,
): Promise<MediaStream> {
  const preferredBeforeCapture = await findBrowserAudioInput(inputDeviceName);
  let stream = await abortableMediaStream(
    navigator.mediaDevices.getUserMedia({
      audio: {
        ...REALTIME_SPEECH_CONSTRAINTS,
        ...(preferredBeforeCapture
          ? { deviceId: { exact: preferredBeforeCapture.deviceId } }
          : {}),
      },
    }),
    signal,
  );

  // WebKit may hide device labels until the origin has opened its first
  // permitted stream. Resolve the native preference again after that grant and
  // switch without dropping the working default stream if the preferred device
  // cannot be opened.
  if (!preferredBeforeCapture && inputDeviceName?.trim()) {
    const preferredAfterCapture = await findBrowserAudioInput(inputDeviceName);
    const currentLabel = stream.getAudioTracks?.()[0]?.label?.trim().toLocaleLowerCase() ?? "";
    if (preferredAfterCapture && preferredAfterCapture.label.trim().toLocaleLowerCase() !== currentLabel) {
      try {
        const preferredStream = await abortableMediaStream(
          navigator.mediaDevices.getUserMedia({
            audio: {
              ...REALTIME_SPEECH_CONSTRAINTS,
              deviceId: { exact: preferredAfterCapture.deviceId },
            },
          }),
          signal,
        );
        stream.getTracks().forEach((track) => track.stop());
        stream = preferredStream;
      } catch (error) {
        if (signal?.aborted) {
          stream.getTracks().forEach((track) => track.stop());
          throw error;
        }
      }
    }
  }

  for (const track of stream.getAudioTracks?.() ?? []) {
    track.contentHint = "speech";
  }
  return stream;
}

async function findBrowserAudioInput(
  inputDeviceName: string | null | undefined,
): Promise<MediaDeviceInfo | null> {
  const requested = inputDeviceName?.trim().toLocaleLowerCase();
  if (!requested || typeof navigator.mediaDevices.enumerateDevices !== "function") return null;
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "audioinput" && device.deviceId && device.label.trim());
    return inputs.find((device) => device.label.trim().toLocaleLowerCase() === requested)
      ?? inputs.find((device) => {
        const label = device.label.trim().toLocaleLowerCase();
        return label.includes(requested) || requested.includes(label);
      })
      ?? null;
  } catch {
    return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Realtime voice connection was cancelled.", "AbortError");
}

async function heartbeatRealtimeVoiceLease(leaseId: string): Promise<boolean> {
  const response = await fetch(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/${encodeURIComponent(leaseId)}`, {
    method: "PUT",
  });
  return response.ok;
}

async function releaseRealtimeVoiceLease(leaseId: string, finalization?: { state: string; reason?: string; seconds?: number }): Promise<void> {
  const response = await fetch(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/${encodeURIComponent(leaseId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(finalization ?? { state: "unconfirmed" }),
    keepalive: true,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not release realtime voice lease (HTTP ${response.status}).`);
  }
}
