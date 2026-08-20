export type ScoutVoiceSessionEventName =
  | "session.started"
  | "session.state"
  | "session.partial"
  | "session.final"
  | "session.error"
  | "session.cancelled";

export type ScoutVoiceSessionEvent = {
  event: ScoutVoiceSessionEventName;
  sessionId: string;
  data: Record<string, unknown>;
  ts: number;
};

export type ScoutVoicePreference = "auto" | "parakeet" | "apple";

export type ScoutVoiceInputDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type ScoutVoicePermissionStatus = {
  kind: "microphone" | "speechRecognition";
  status: string;
  granted: boolean;
  canRequest: boolean;
};

export type ScoutVoiceSettings = {
  preference: ScoutVoicePreference;
  inputDeviceId: string | null;
  inputDeviceName: string | null;
  modelReady?: boolean;
  modelInstalled?: boolean;
  permissions?: ScoutVoicePermissionStatus[];
};

export type ScoutVoiceHostCommand =
  | {
    type: "session.start";
    sessionId: string;
    clientId: string;
    surface: string;
    language?: string;
    inputDeviceId?: string | null;
    inputDeviceName?: string | null;
  }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string }
  | {
    type: "settings.apply";
    preference?: ScoutVoicePreference;
    inputDeviceId?: string | null;
  }
  | { type: "permissions.open"; kind: "microphone" | "speechRecognition" }
  | { type: "permissions.request"; kind: "microphone" | "speechRecognition" };

export type ScoutVoiceCaptureMode = "native" | "browser";

export type ScoutVoiceHealthSnapshot = {
  ok: boolean;
  service: "scout-voice";
  adapter: "hudson-dictation";
  capture: ScoutVoiceCaptureMode;
  detail: string | null;
  microphoneGranted?: boolean;
  microphoneCanRequest?: boolean;
  host?: {
    hostId: string;
    platform: string;
    lastSeenAt: number;
  } | null;
};

type SessionStatus = "pending" | "active" | "processing" | "done" | "cancelled" | "error";

type VoiceSession = {
  id: string;
  clientId: string;
  surface: string;
  language: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  assignedHostId: string | null;
  events: ScoutVoiceSessionEvent[];
  error: string | null;
};

type VoiceHost = {
  hostId: string;
  instanceId: string | null;
  platform: string;
  bundle: string | null;
  registeredAt: number;
  lastSeenAt: number;
  activePollId: number | null;
  pendingCommands: ScoutVoiceHostCommand[];
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
};

type SessionSubscriber = (event: ScoutVoiceSessionEvent) => void;

const HOST_STALE_MS = 45_000;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_EVENTS_PER_SESSION = 200;

const sessions = new Map<string, VoiceSession>();
const hosts = new Map<string, VoiceHost>();
const sessionSubscribers = new Map<string, Set<SessionSubscriber>>();
let nextHostPollId = 1;

const DEFAULT_VOICE_SETTINGS: ScoutVoiceSettings = {
  preference: "auto",
  inputDeviceId: null,
  inputDeviceName: null,
};

export function resetScoutVoiceSessionStateForTests(): void {
  sessions.clear();
  hosts.clear();
  sessionSubscribers.clear();
  nextHostPollId = 1;
}

export function registerScoutVoiceHost(input: {
  hostId: string;
  instanceId?: string;
  platform: string;
  bundle?: string;
  settings?: Partial<ScoutVoiceSettings>;
  devices?: ScoutVoiceInputDevice[];
}): { ok: true; hostId: string; pollMs: number } {
  const hostId = input.hostId.trim();
  if (!hostId) {
    throw new ScoutVoiceSessionError("host_id_required", "hostId is required.", 400);
  }

  const now = Date.now();
  const previous = hosts.get(hostId);
  const instanceId = input.instanceId?.trim() || null;
  const settings = mergeVoiceSettings(previous?.settings ?? DEFAULT_VOICE_SETTINGS, input.settings);
  hosts.set(hostId, {
    hostId,
    instanceId,
    platform: input.platform.trim() || "unknown",
    bundle: input.bundle?.trim() || null,
    registeredAt: previous?.registeredAt ?? now,
    lastSeenAt: now,
    activePollId: previous?.instanceId === instanceId ? (previous?.activePollId ?? null) : null,
    pendingCommands: previous?.pendingCommands ?? [],
    settings,
    devices: input.devices?.length ? input.devices : (previous?.devices ?? []),
  });

  return { ok: true, hostId, pollMs: 500 };
}

export function getScoutVoiceSettingsSnapshot(): {
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
} {
  const host = pickLiveVoiceHost();
  return {
    settings: host?.settings ?? DEFAULT_VOICE_SETTINGS,
    devices: host?.devices ?? [],
  };
}

export function openScoutVoicePrivacySettings(
  kind: "microphone" | "speechRecognition" = "microphone",
): { ok: true } {
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }
  host.lastSeenAt = Date.now();
  queueHostCommand(host.hostId, { type: "permissions.open", kind });
  return { ok: true };
}

export function requestScoutVoicePermissions(
  kind: "microphone" | "speechRecognition" = "microphone",
): { ok: true } {
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }
  host.lastSeenAt = Date.now();
  queueHostCommand(host.hostId, { type: "permissions.request", kind });
  return { ok: true };
}

export function updateScoutVoiceSettings(input: {
  preference?: ScoutVoicePreference;
  inputDeviceId?: string | null;
}): {
  settings: ScoutVoiceSettings;
  devices: ScoutVoiceInputDevice[];
} {
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }

  const nextSettings = mergeVoiceSettings(host.settings, {
    ...(input.preference ? { preference: input.preference } : {}),
    ...(input.inputDeviceId !== undefined ? { inputDeviceId: input.inputDeviceId } : {}),
  });
  if (input.inputDeviceId !== undefined) {
    const device = host.devices.find((entry) => entry.id === input.inputDeviceId);
    nextSettings.inputDeviceName = device?.name ?? (input.inputDeviceId ? nextSettings.inputDeviceName : null);
  }
  host.settings = nextSettings;
  host.lastSeenAt = Date.now();
  queueHostCommand(host.hostId, {
    type: "settings.apply",
    preference: nextSettings.preference,
    inputDeviceId: nextSettings.inputDeviceId,
  });
  return {
    settings: nextSettings,
    devices: host.devices,
  };
}

export function touchScoutVoiceHost(hostId: string): void {
  const host = hosts.get(hostId.trim());
  if (!host) return;
  host.lastSeenAt = Date.now();
}

export function awaitScoutVoiceHostCommand(
  hostId: string,
  timeoutMs = 25_000,
  instanceId?: string,
  signal?: AbortSignal,
): Promise<{ command: ScoutVoiceHostCommand | null }> {
  const normalizedHostId = hostId.trim();
  const normalizedInstanceId = instanceId?.trim() || null;
  const host = hosts.get(normalizedHostId);
  if (!host) {
    throw new ScoutVoiceSessionError("host_unknown", "Voice host is not registered.", 404);
  }

  // A terminated helper can leave a long poll alive in the web server until
  // its timeout expires. Once a replacement helper registers, that stale poll
  // must not consume commands intended for the replacement process.
  if (host.instanceId !== normalizedInstanceId) {
    return Promise.resolve({ command: null });
  }

  // URLSession can abandon a long poll while its server-side promise remains
  // alive. The replacement poll from the same helper process supersedes that
  // abandoned request so only the newest connection may dequeue a command.
  const pollId = nextHostPollId++;
  host.activePollId = pollId;

  touchScoutVoiceHost(normalizedHostId);
  pruneExpiredSessions();

  if (host.pendingCommands.length > 0) {
    const command = host.pendingCommands.shift() ?? null;
    host.activePollId = null;
    return Promise.resolve({ command });
  }

  if (signal?.aborted) {
    host.activePollId = null;
    return Promise.resolve({ command: null });
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (command: ScoutVoiceHostCommand | null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      signal?.removeEventListener("abort", abort);
      const current = hosts.get(normalizedHostId);
      if (current?.activePollId === pollId) current.activePollId = null;
      resolve({ command });
    };
    const abort = () => finish(null);
    const timer = setInterval(() => {
      const current = hosts.get(normalizedHostId);
      if (!current) {
        finish(null);
        return;
      }
      if (current.instanceId !== normalizedInstanceId || current.activePollId !== pollId) {
        finish(null);
        return;
      }
      current.lastSeenAt = Date.now();
      if (current.pendingCommands.length > 0) {
        const command = current.pendingCommands.shift() ?? null;
        finish(command);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        finish(null);
      }
    }, 100);
    signal?.addEventListener("abort", abort, { once: true });
    // Close the narrow race where cancellation lands after the preflight
    // check but before the listener is attached. AbortSignal does not replay
    // an already-dispatched event to a late subscriber.
    if (signal?.aborted) abort();
  });
}

export function pushScoutVoiceHostEvent(input: {
  hostId: string;
  instanceId?: string;
  sessionId: string;
  event: ScoutVoiceSessionEventName;
  data?: Record<string, unknown>;
}): ScoutVoiceSessionEvent {
  const host = hosts.get(input.hostId.trim());
  if (!host) {
    throw new ScoutVoiceSessionError("host_unknown", "Voice host is not registered.", 404);
  }
  const instanceId = input.instanceId?.trim() || null;
  if (host.instanceId !== instanceId) {
    throw new ScoutVoiceSessionError("host_instance_mismatch", "Voice host process is no longer active.", 409);
  }
  touchScoutVoiceHost(host.hostId);

  const session = sessions.get(input.sessionId);
  if (!session) {
    throw new ScoutVoiceSessionError("session_unknown", "Voice session was not found.", 404);
  }

  if (session.assignedHostId && session.assignedHostId !== host.hostId) {
    throw new ScoutVoiceSessionError("session_host_mismatch", "Voice session belongs to another host.", 409);
  }

  session.assignedHostId = host.hostId;
  return appendSessionEvent(session, input.event, input.data ?? {});
}

export function createScoutVoiceSession(input: {
  clientId?: string;
  surface?: string;
  language?: string;
  sessionId?: string;
}): { sessionId: string; capture: ScoutVoiceCaptureMode } {
  pruneExpiredSessions();
  const host = pickLiveVoiceHost();
  if (!host) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }

  const sessionId = input.sessionId?.trim() || createSessionId();
  cancelStaleHostSessions(host.hostId, sessionId);
  const now = Date.now();
  const session: VoiceSession = {
    id: sessionId,
    clientId: input.clientId?.trim() || "openscout-web",
    surface: input.surface?.trim() || "web",
    language: input.language?.trim() || "en",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    assignedHostId: host.hostId,
    events: [],
    error: null,
  };
  sessions.set(sessionId, session);

  const inputDevice = resolveSessionInputDevice(host);
  queueHostCommand(host.hostId, {
    type: "session.start",
    sessionId,
    clientId: session.clientId,
    surface: session.surface,
    language: session.language,
    inputDeviceId: inputDevice?.id ?? null,
    inputDeviceName: inputDevice?.name ?? null,
  });

  appendSessionEvent(session, "session.started", { state: "starting" });
  return { sessionId, capture: "native" };
}

export function stopScoutVoiceSession(sessionId: string): void {
  const session = requireSession(sessionId);
  if (session.status === "done" || session.status === "cancelled" || session.status === "error") {
    return;
  }
  session.status = "processing";
  session.updatedAt = Date.now();
  appendSessionEvent(session, "session.state", { state: "processing" });
  dispatchSessionCommand(session, { type: "session.stop", sessionId: session.id });
}

export function cancelScoutVoiceSession(sessionId: string): void {
  const session = requireSession(sessionId);
  if (session.status === "done" || session.status === "cancelled" || session.status === "error") {
    return;
  }
  session.status = "cancelled";
  session.updatedAt = Date.now();
  dispatchSessionCommand(session, { type: "session.cancel", sessionId: session.id });
  appendSessionEvent(session, "session.cancelled", { reason: "client" });
}

export function subscribeScoutVoiceSession(
  sessionId: string,
  handler: SessionSubscriber,
): () => void {
  const session = requireSession(sessionId);
  const subscribers = sessionSubscribers.get(session.id) ?? new Set<SessionSubscriber>();
  subscribers.add(handler);
  sessionSubscribers.set(session.id, subscribers);

  for (const event of session.events) {
    handler(event);
  }

  return () => {
    const current = sessionSubscribers.get(session.id);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) sessionSubscribers.delete(session.id);
  };
}

export function formatScoutVoiceSessionSse(event: ScoutVoiceSessionEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify({
    sessionId: event.sessionId,
    ...event.data,
    ts: event.ts,
  })}\n\n`;
}

export function isScoutVoiceHostAvailable(now = Date.now()): boolean {
  pruneExpiredSessions(now);
  return pickLiveVoiceHost(now) !== null;
}

export type ScoutVoiceSessionHistoryEntry = {
  sessionId: string;
  status: SessionStatus;
  surface: string;
  clientId: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  eventCount: number;
  lastEvent: ScoutVoiceSessionEventName | null;
  lastTranscript: string | null;
};

export function listScoutVoiceSessionHistory(limit = 20, now = Date.now()): ScoutVoiceSessionHistoryEntry[] {
  pruneExpiredSessions(now);
  const capped = Math.max(1, Math.min(limit, 50));
  return [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, capped)
    .map((session) => ({
      sessionId: session.id,
      status: session.status,
      surface: session.surface,
      clientId: session.clientId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      error: session.error,
      eventCount: session.events.length,
      lastEvent: session.events.at(-1)?.event ?? null,
      lastTranscript: findLastTranscript(session.events),
    }));
}

export function getScoutVoiceHealthSnapshot(now = Date.now()): ScoutVoiceHealthSnapshot {
  pruneExpiredSessions(now);
  const host = pickLiveVoiceHost(now);
  if (!host) {
    return {
      ok: false,
      service: "scout-voice",
      adapter: "hudson-dictation",
      capture: "native",
      detail: "Scout voice host is not running. Launch Scout Menu and try again.",
      host: null,
    };
  }

  const micPermission = host.settings.permissions?.find((entry) => entry.kind === "microphone");
  const microphoneGranted = micPermission?.granted ?? false;
  const microphoneCanRequest = micPermission?.canRequest ?? false;
  if (!microphoneGranted) {
    const detail = micPermission?.status === "denied"
      ? "Microphone access is off for Scout Menu. Choose Retry access to reopen the macOS permission pane."
      : microphoneCanRequest
        ? "Microphone has not been requested yet. Tap the mic or choose Request access to show the macOS prompt."
        : "Scout Menu needs microphone access before dictation can start.";
    return {
      ok: false,
      service: "scout-voice",
      adapter: "hudson-dictation",
      capture: "native",
      detail,
      microphoneGranted: false,
      microphoneCanRequest,
      host: {
        hostId: host.hostId,
        platform: host.platform,
        lastSeenAt: host.lastSeenAt,
      },
    };
  }

  return {
    ok: true,
    service: "scout-voice",
    adapter: "hudson-dictation",
    capture: "native",
    detail: null,
    microphoneGranted: true,
    microphoneCanRequest: false,
    host: {
      hostId: host.hostId,
      platform: host.platform,
      lastSeenAt: host.lastSeenAt,
    },
  };
}

export function isTerminalScoutVoiceSessionEvent(event: ScoutVoiceSessionEvent): boolean {
  if (event.event === "session.final" || event.event === "session.error" || event.event === "session.cancelled") {
    return true;
  }
  if (event.event !== "session.state") return false;
  const state = event.data.state;
  return state === "done" || state === "error" || state === "cancelled";
}

export class ScoutVoiceSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ScoutVoiceSessionError";
    this.code = code;
    this.status = status;
  }
}

function requireSession(sessionId: string): VoiceSession {
  const session = sessions.get(sessionId.trim());
  if (!session) {
    throw new ScoutVoiceSessionError("session_unknown", "Voice session was not found.", 404);
  }
  return session;
}

function pickLiveVoiceHost(now = Date.now()): VoiceHost | null {
  let selected: VoiceHost | null = null;
  for (const host of hosts.values()) {
    if (now - host.lastSeenAt > HOST_STALE_MS) continue;
    if (!selected || host.lastSeenAt > selected.lastSeenAt) {
      selected = host;
    }
  }
  return selected;
}

function queueHostCommand(hostId: string, command: ScoutVoiceHostCommand): void {
  const host = hosts.get(hostId);
  if (!host) {
    throw new ScoutVoiceSessionError("host_unknown", "Voice host is not registered.", 404);
  }
  host.pendingCommands.push(command);
  host.lastSeenAt = Date.now();
}

function dispatchSessionCommand(session: VoiceSession, command: ScoutVoiceHostCommand): void {
  const hostId = session.assignedHostId ?? pickLiveVoiceHost()?.hostId;
  if (!hostId) {
    throw new ScoutVoiceSessionError(
      "host_unavailable",
      "Scout voice host is not running. Launch Scout Menu and try again.",
      503,
    );
  }
  session.assignedHostId = hostId;
  queueHostCommand(hostId, command);
}

function appendSessionEvent(
  session: VoiceSession,
  event: ScoutVoiceSessionEventName,
  data: Record<string, unknown>,
): ScoutVoiceSessionEvent {
  const payload: ScoutVoiceSessionEvent = {
    event,
    sessionId: session.id,
    data,
    ts: Date.now(),
  };
  session.events.push(payload);
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
  }
  session.updatedAt = payload.ts;

  if (event === "session.state") {
    const state = data.state;
    if (state === "recording" || state === "starting") session.status = "active";
    if (state === "processing") session.status = "processing";
    if (state === "done") session.status = "done";
    if (state === "cancelled") session.status = "cancelled";
    if (state === "error") session.status = "error";
  }
  if (event === "session.final") session.status = "done";
  if (event === "session.error") {
    session.status = "error";
    session.error = typeof data.message === "string" ? data.message : "Scout voice session failed.";
  }
  if (event === "session.cancelled") session.status = "cancelled";

  const subscribers = sessionSubscribers.get(session.id);
  if (subscribers) {
    for (const handler of subscribers) handler(payload);
  }
  return payload;
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.updatedAt <= SESSION_TTL_MS) continue;
    sessions.delete(sessionId);
    sessionSubscribers.delete(sessionId);
  }
}

function cancelStaleHostSessions(hostId: string, nextSessionId: string): void {
  for (const session of sessions.values()) {
    if (session.id === nextSessionId) continue;
    if (session.assignedHostId !== hostId) continue;
    if (session.status === "done" || session.status === "cancelled" || session.status === "error") continue;
    session.status = "cancelled";
    session.updatedAt = Date.now();
    appendSessionEvent(session, "session.cancelled", { reason: "superseded" });
  }
}

function createSessionId(): string {
  return `scout-voice:${crypto.randomUUID()}`;
}

function resolveSessionInputDevice(host: VoiceHost): { id: string; name: string } | null {
  const devices = host.devices;
  if (!devices.length) return null;
  const selected = host.settings.inputDeviceId
    ? devices.find((device) => device.id === host.settings.inputDeviceId)
    : null;
  const fallback = devices.find((device) => device.isDefault) ?? devices[0] ?? null;
  const device = selected ?? fallback;
  return device ? { id: device.id, name: device.name } : null;
}

function findLastTranscript(events: ScoutVoiceSessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event !== "session.final") continue;
    const text = event.data.text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  return null;
}

function mergeVoiceSettings(
  current: ScoutVoiceSettings,
  patch?: Partial<ScoutVoiceSettings>,
): ScoutVoiceSettings {
  if (!patch) return current;
  return {
    ...current,
    ...patch,
  };
}
