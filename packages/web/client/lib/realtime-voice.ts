import {
  SCOUT_REALTIME_SCOUTBOT_CHAT_PATH,
  SCOUT_REALTIME_VOICE_FAR_FIELD_INPUT,
  SCOUT_REALTIME_VOICE_CALL_PATH,
  SCOUT_REALTIME_VOICE_LEASE_HEADER,
  SCOUT_REALTIME_VOICE_LEASE_PATH,
  SCOUT_REALTIME_VOICE_NEAR_FIELD_INPUT,
} from "../../shared/realtime-voice.ts";
import { extractScoutbotUiActions, stripScoutbotUiFences } from "./scoutbot.ts";

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
  };
};

type ScoutRealtimeFunctionCall = {
  callId: string;
  name: string;
  arguments: string;
};

type ScoutbotChatResult = {
  reply?: { body?: unknown };
};

export async function startScoutRealtimeVoiceCall(callbacks: {
  onState?: (state: ScoutRealtimeVoiceConnectionState) => void;
  onError?: (message: string) => void;
  onScoutbotReply?: (
    body: string,
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

  callbacks.onState?.("connecting");
  const peerConnection = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
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

  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    callbacks.signal?.removeEventListener("abort", stopAfterAbort);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    mediaStream?.getTracks().forEach((track) => track.stop());
    audio.pause();
    audio.srcObject = null;
    peerConnection.close();
    const leaseToRelease = leaseId;
    leaseId = null;
    stopPromise = (async () => {
      if (leaseToRelease) await releaseRealtimeVoiceLease(leaseToRelease);
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
        if (!stopped) callbacks.onError?.("Realtime voice audio ended unexpectedly.");
      });
    }
    audio.srcObject = stream;
    void audio.play()
      .catch(() => {
        callbacks.onError?.("Browser playback was blocked. Interact with the page, then start the call again.");
      });
  };
  peerConnection.onconnectionstatechange = () => {
    if (stopped) return;
    if (peerConnection.connectionState === "connected") {
      callbacks.onState?.("live");
      trace("Realtime channel connected", "Scoutbot bridge is ready");
    } else if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
      callbacks.onError?.("Realtime voice connection ended unexpectedly.");
      stopQuietly();
    }
  };

  try {
    mediaStream = await acquireRealtimeVoiceMediaStream(
      callbacks.inputDeviceName,
      callbacks.signal,
    );
    throwIfAborted(callbacks.signal);
    for (const track of mediaStream.getTracks()) {
      peerConnection.addTrack(track, mediaStream);
    }

    const events = peerConnection.createDataChannel("oai-events");
    const handledFunctionCallIds = new Set<string>();
    let functionQueue = Promise.resolve();
    let responseActive = false;
    let responseRequestInFlight: string | null = null;
    const pendingResponseInstructions: string[] = [];
    const sendRealtimeEvent = (payload: unknown): boolean => {
      if (stopped || events.readyState !== "open") return false;
      try {
        events.send(JSON.stringify(payload));
        return true;
      } catch {
        callbacks.onError?.("Realtime voice events channel closed unexpectedly.");
        return false;
      }
    };
    const flushResponseQueue = () => {
      if (responseActive || responseRequestInFlight || pendingResponseInstructions.length === 0) return;
      const instructions = pendingResponseInstructions.shift();
      if (!instructions) return;
      responseRequestInFlight = instructions;
      if (!sendRealtimeEvent({ type: "response.create", response: { instructions } })) {
        responseRequestInFlight = null;
        pendingResponseInstructions.unshift(instructions);
        return;
      }
      // Treat a sent response.create as active immediately. Waiting for the
      // provider's response.created event leaves a race where a second local
      // tool result can issue another response.create against the same turn.
      responseActive = true;
    };
    const requestResponse = (instructions: string) => {
      pendingResponseInstructions.push(instructions);
      flushResponseQueue();
    };
    events.addEventListener("open", () => {
      if (stopped) return;
      const inputProfile = realtimeVoiceInputProfile(callbacks.inputDeviceName);
      if (!sendRealtimeEvent({
        type: "session.update",
        session: {
          type: "realtime",
          audio: { input: inputProfile },
        },
      })) {
        callbacks.onError?.("Could not configure Scout's realtime microphone processing.");
        return;
      }
      trace("Scoutbot bridge ready", "Live fleet context is available");
      requestResponse("Open with one brief audible greeting: 'Hi, I’m Scoutbot. I can check the fleet and coordinate through Scout. What would you like to work on?'");
    });
    events.addEventListener("error", () => {
      if (!stopped) callbacks.onError?.("Realtime voice events channel closed unexpectedly.");
    });
    events.addEventListener("message", (event) => {
      const payload = parseRealtimeEvent(event.data);
      if (payload?.type === "error") {
        if (isActiveResponseError(payload.message)) {
          if (responseRequestInFlight) {
            pendingResponseInstructions.unshift(responseRequestInFlight);
            responseRequestInFlight = null;
          }
          responseActive = true;
          trace("Scoutbot reply queued", "Waiting for the current spoken response to finish", "scoutbot");
          return;
        }
        callbacks.onError?.(payload.message ?? "OpenAI Realtime reported an error.");
        return;
      }
      if (payload?.type === "response.created") {
        responseActive = true;
        responseRequestInFlight = null;
        return;
      }
      if (payload?.type !== "response.done") return;
      responseActive = false;
      responseRequestInFlight = null;
      for (const functionCall of extractFunctionCalls(payload)) {
        if (functionCall.name !== "ask_scoutbot" || handledFunctionCallIds.has(functionCall.callId)) continue;
        handledFunctionCallIds.add(functionCall.callId);
        functionQueue = functionQueue
          .then(() => fulfillScoutbotFunctionCall({
            functionCall,
            route: callbacks.getRoute?.() ?? callbacks.route,
            uiContext: callbacks.getUiContext?.(),
            onReply: callbacks.onScoutbotReply,
            onTrace: trace,
            send: sendRealtimeEvent,
            requestResponse,
          }))
          .catch((error) => {
            callbacks.onError?.(error instanceof Error ? error.message : "Scoutbot could not complete the voice request.");
          });
      }
      flushResponseQueue();
    });

    const offer = await abortable(peerConnection.createOffer(), callbacks.signal);
    await abortable(peerConnection.setLocalDescription(offer), callbacks.signal);
    if (!offer.sdp) {
      throw new Error("Could not create a WebRTC offer.");
    }

    const response = await fetch(SCOUT_REALTIME_VOICE_CALL_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
      },
      body: offer.sdp,
      signal: callbacks.signal,
    });
    leaseId = response.headers.get(SCOUT_REALTIME_VOICE_LEASE_HEADER)?.trim() || null;
    const answerSdp = await abortable(response.text(), callbacks.signal);
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
      callbacks.signal,
    );
    throwIfAborted(callbacks.signal);

    return { leaseId, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function fulfillScoutbotFunctionCall(input: {
  functionCall: ScoutRealtimeFunctionCall;
  route: unknown;
  uiContext?: unknown;
  onReply?: (
    body: string,
  ) => ScoutRealtimeVoiceReplyActions | Promise<ScoutRealtimeVoiceReplyActions>;
  onTrace: (label: string, detail?: string, kind?: ScoutRealtimeVoiceTraceKind) => void;
  send: (payload: unknown) => boolean;
  requestResponse: (instructions: string) => void;
}): Promise<void> {
  const request = readScoutbotRequest(input.functionCall.arguments);
  if (!request) {
    input.onTrace("Scoutbot request could not be read", undefined, "error");
    sendScoutbotFunctionOutput(input, { ok: false, error: "The voice request did not include a usable Scoutbot prompt." });
    return;
  }

  input.onTrace("Scoutbot is checking the control plane", request, "scoutbot");
  try {
    const response = await fetch(SCOUT_REALTIME_SCOUTBOT_CHAT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: request, route: input.route, uiContext: input.uiContext }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(readScoutbotChatError(raw, response.status));
    }
    const parsed = JSON.parse(raw) as ScoutbotChatResult;
    const body = typeof parsed.reply?.body === "string" ? parsed.reply.body.trim() : "";
    if (!body) {
      throw new Error("Scoutbot returned an empty reply.");
    }

    const agentRequestCount = extractScoutbotUiActions(body)
      .filter((action) => action.type === "ask-agent")
      .length;
    const replyActions = input.onReply
      ? await input.onReply(body)
      : {
          agentRequests: {
            requested: agentRequestCount,
            sent: 0,
            failed: agentRequestCount,
          },
        };
    const spokenReply = stripScoutbotUiFences(body);
    input.onTrace("Scoutbot reply ready", undefined, "scoutbot");
    sendScoutbotFunctionOutput(input, {
      ok: true,
      reply: spokenReply,
      ...(replyActions.agentRequests.requested > 0
        ? { agentRequests: replyActions.agentRequests }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scoutbot could not complete the voice request.";
    input.onTrace("Scoutbot request failed", message, "error");
    sendScoutbotFunctionOutput(input, { ok: false, error: message });
  }
}

function sendScoutbotFunctionOutput(
  input: {
    functionCall: ScoutRealtimeFunctionCall;
    send: (payload: unknown) => boolean;
    requestResponse: (instructions: string) => void;
  },
  output: {
    ok: boolean;
    reply?: string;
    error?: string;
    agentRequests?: ScoutRealtimeVoiceReplyActions["agentRequests"];
  },
): void {
  const sent = input.send({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: input.functionCall.callId,
      output: JSON.stringify(output),
    },
  });
  if (!sent) return;
  const agentRequests = output.agentRequests;
  input.requestResponse(
    output.ok
      ? agentRequests && agentRequests.requested > 0
        ? agentRequests.failed > 0
          ? "Answer using the Scoutbot result. Say clearly that Scoutbot tried to send the agent request automatically but delivery failed, and tell the operator to check the activity log. Be concise and do not mention tools, JSON, fences, or implementation details."
          : "Answer using the Scoutbot result. Say clearly that the agent request was sent automatically. Do not claim the requested work is complete. Be concise and do not mention tools, JSON, fences, or implementation details."
        : "Answer using the Scoutbot result. Speak the useful answer naturally and concisely. Do not mention tools, JSON, fences, or implementation details."
      : "Briefly tell the operator that Scoutbot could not complete the live lookup and state the returned error plainly.",
  );
}

export function isActiveResponseError(message: string | undefined): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("active response in progress")
    || normalized.includes("conversation already has an active response")
    || normalized.includes("response is already in progress");
}

function parseRealtimeEvent(value: unknown): {
  type?: string;
  message?: string;
  response?: { output?: unknown };
} | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as {
      type?: unknown;
      error?: { message?: unknown };
      response?: { output?: unknown };
    };
    return {
      ...(typeof parsed.type === "string" ? { type: parsed.type } : {}),
      ...(typeof parsed.error?.message === "string" ? { message: parsed.error.message } : {}),
      ...(parsed.response && typeof parsed.response === "object" ? { response: parsed.response } : {}),
    };
  } catch {
    return null;
  }
}

function extractFunctionCalls(event: { response?: { output?: unknown } }): ScoutRealtimeFunctionCall[] {
  if (!Array.isArray(event.response?.output)) return [];
  return event.response.output.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
    if (
      item.type !== "function_call"
      || typeof item.call_id !== "string"
      || typeof item.name !== "string"
      || typeof item.arguments !== "string"
    ) {
      return [];
    }
    return [{ callId: item.call_id, name: item.name, arguments: item.arguments }];
  });
}

function readScoutbotRequest(argumentsJson: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson) as { request?: unknown };
    if (typeof parsed.request !== "string") return null;
    const request = parsed.request.trim();
    return request ? request.slice(0, 8_000) : null;
  } catch {
    return null;
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

const NEAR_FIELD_INPUT_LABEL = /\b(?:airpods?|earbuds?|earphones?|headsets?|headphones?|buds?|hands[- ]?free)\b/iu;

function realtimeVoiceInputProfile(inputDeviceName: string | null | undefined) {
  return NEAR_FIELD_INPUT_LABEL.test(inputDeviceName?.trim() ?? "")
    ? SCOUT_REALTIME_VOICE_NEAR_FIELD_INPUT
    : SCOUT_REALTIME_VOICE_FAR_FIELD_INPUT;
}

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

async function releaseRealtimeVoiceLease(leaseId: string): Promise<void> {
  const response = await fetch(`${SCOUT_REALTIME_VOICE_LEASE_PATH}/${encodeURIComponent(leaseId)}`, {
    method: "DELETE",
    keepalive: true,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not release realtime voice lease (HTTP ${response.status}).`);
  }
}
