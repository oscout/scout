import {
  SCOUT_SURFACE_PROTOCOL_VERSION,
  type CodexDeckRoute,
  type FleetDispatchDelta,
  type FleetTailDelta,
  type HostScope,
  type LaneSelection,
  type NativeVoiceSnapshot,
  type RequestId,
  type RoutedAskRequest,
  type RoutedAskReceipt,
  type RoutedReviewRequest,
  type RoutedReviewReceipt,
  type ScoutSurfaceClient,
  type ScoutSurfaceMethod,
  type ScoutSurfaceMethodContract,
  type ScoutSurfaceReply,
  type ScoutSurfaceRequest,
  type ScoutSurfaceId,
  type SurfaceBootstrap,
  type SurfacePreference,
  type SurfacePreferenceKey,
  type SurfacePreferences,
} from "./scout-surface-contract.ts";
import { NativeScoutSurfaceClient } from "./native-scout-surface-client.ts";
import {
  engageScoutVoiceDictation,
  formatScoutVoiceIssue,
  getSharedScoutVoiceClient,
  type ScoutVoiceLiveHandle,
  type ScoutVoiceSessionState,
} from "../lib/scout-voice.ts";

const DECK_SURFACE_PATH = "/api/surfaces/deck";
const PREFERENCES_STORAGE_KEY = "scout.surface.preferences.v1";

export function createScoutSurfaceClient(
  surface: ScoutSurfaceId,
  currentScope: () => HostScope,
): ScoutSurfaceClient {
  if (window.webkit?.messageHandlers?.scoutSurface) {
    return new NativeScoutSurfaceClient(surface, currentScope);
  }
  return new WebScoutSurfaceClient(surface, currentScope);
}

/**
 * Same surface contract as the native WKWebView bridge, transported through
 * the trusted same-origin OpenScout web server. Browser-owned concerns
 * (speech, external URLs and preferences) stay in the browser; fleet and Codex
 * operations cross the allowlisted server boundary.
 */
export class WebScoutSurfaceClient implements ScoutSurfaceClient {
  private readonly pending = new Map<RequestId, AbortController>();
  private readonly voice = new BrowserVoiceController();

  constructor(
    private readonly surface: ScoutSurfaceId,
    private readonly currentScope: () => HostScope,
    private readonly endpoint = DECK_SURFACE_PATH,
  ) {}

  async bootstrap(): Promise<SurfaceBootstrap> {
    const value = await this.request("bootstrap", {});
    if (!this.voice.inputAvailable) return value;
    const capabilities = new Set(value.capabilities);
    capabilities.add("native.voice.snapshot");
    capabilities.add("native.voice.toggleInput");
    if (this.voice.outputAvailable) {
      capabilities.add("native.voice.speak");
      capabilities.add("native.voice.stopOutput");
    }
    return {
      ...value,
      capabilities: [...capabilities],
      device: {
        platform: "web",
        formFactor: browserFormFactor(),
      },
    };
  }

  agents = {
    list: (scope: HostScope) => this.request("agents.list", {}, scope),
    observe: (scope: HostScope, agentIds: readonly string[]) =>
      this.request("agents.observe", { agentIds }, scope),
  };

  tail = {
    recent: (scope: HostScope, cursor?: string) =>
      this.request("tail.recent", { ...(cursor ? { cursor } : {}) }, scope),
    subscribe: (scope: HostScope, listener: (delta: FleetTailDelta) => void) => {
      let known = new Set<string>();
      const poll = async () => {
        try {
          const fleet = await this.tail.recent(scope);
          for (const host of fleet.hosts) {
            if (!host.ready) continue;
            const next = host.value.events.filter((event) => !known.has(event.id));
            known = new Set(host.value.events.map((event) => event.id));
            if (next.length > 0) listener({ hostId: host.hostId, cursor: host.value.cursor, events: next });
          }
        } catch {
          // Polling is opportunistic. The owning surface's snapshot loop carries
          // connection errors and remains the visible source of truth.
        }
      };
      void poll();
      const timer = window.setInterval(() => void poll(), 2_000);
      return () => {
        window.clearInterval(timer);
      };
    },
  };

  codex = {
    startSession: (route: CodexDeckRoute) => this.request("codex.session.start", { route }),
    snapshot: (route: CodexDeckRoute) => this.request("codex.thread.snapshot", { route }),
    connect: (route: CodexDeckRoute) => this.request("codex.thread.connect", { route }),
    start: (route: CodexDeckRoute, text: string) => this.request("codex.turn.start", { route, text }),
    steer: (route: CodexDeckRoute, text: string) => this.request("codex.turn.steer", { route, text }),
    interrupt: (route: CodexDeckRoute) => this.request("codex.turn.interrupt", { route }),
  };

  dispatch = {
    diagnostics: () => Promise.reject(new Error("Dispatch is unavailable on the Deck surface.")),
    ask: (_request: RoutedAskRequest): Promise<RoutedAskReceipt> =>
      Promise.reject(new Error("Dispatch is unavailable on the Deck surface.")),
    review: (_request: RoutedReviewRequest): Promise<RoutedReviewReceipt> =>
      Promise.reject(new Error("Dispatch is unavailable on the Deck surface.")),
    subscribe: (_scope: HostScope, _listener: (delta: FleetDispatchDelta) => void) => () => {},
  };

  native = {
    setLaneSelection: async (selection: LaneSelection | null) => {
      await this.request("native.setLaneSelection", { selection });
    },
    openExternalURL: async (url: string) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error("Only https URLs can be opened from the Deck.");
      window.open(parsed, "_blank", "noopener,noreferrer");
    },
    getPreferences: async (keys: readonly SurfacePreferenceKey[]): Promise<SurfacePreferences> => {
      const values = readPreferences();
      return { entries: values.filter((entry) => keys.includes(entry.key)) };
    },
    setPreferences: async (values: SurfacePreferences) => {
      const next = new Map(readPreferences().map((entry) => [entry.key, entry]));
      for (const entry of values.entries) next.set(entry.key, entry);
      localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify([...next.values()]));
    },
    cancel: async (requestId: RequestId) => {
      this.pending.get(requestId)?.abort();
      this.pending.delete(requestId);
    },
    voice: {
      snapshot: () => Promise.resolve(this.voice.snapshot()),
      toggleInput: () => this.voice.toggleInput(),
      speak: (text: string) => this.voice.speak(text),
      stopOutput: () => this.voice.stopOutput(),
    },
  };

  selectedScope(): HostScope {
    return this.currentScope();
  }

  private async request<M extends ScoutSurfaceMethod>(
    method: M,
    params: ScoutSurfaceMethodContract[M]["params"],
    scope?: HostScope,
  ): Promise<ScoutSurfaceMethodContract[M]["result"]> {
    if (this.surface !== "deck") throw new Error("The web surface transport currently supports Scout Deck only.");
    const id = requestId();
    const controller = new AbortController();
    this.pending.set(id, controller);
    const message = {
      v: SCOUT_SURFACE_PROTOCOL_VERSION,
      id,
      surface: this.surface,
      method,
      params,
      ...(scope ? { hostIds: scope.hostIds } : {}),
    } as ScoutSurfaceRequest;

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `Scout Deck web bridge returned HTTP ${response.status}.`);
      }
      const reply = await response.json() as ScoutSurfaceReply;
      if (reply.v !== SCOUT_SURFACE_PROTOCOL_VERSION || reply.id !== id || reply.method !== method) {
        throw new Error("Scout Deck web bridge returned a mismatched reply.");
      }
      if ("error" in reply) throw new Error(`${reply.error.code}: ${reply.error.message}`);
      return reply.result as ScoutSurfaceMethodContract[M]["result"];
    } finally {
      this.pending.delete(id);
    }
  }
}

class BrowserVoiceController {
  private live: ScoutVoiceLiveHandle | null = null;
  private inputRun = 0;
  private state: NativeVoiceSnapshot = {
    input: {
      state: "idle",
      partialText: "",
      finalText: "",
      finalCount: 0,
      engine: "parakeet",
      modelReady: true,
      unavailableReason: null,
    },
    output: { speaking: false },
  };

  get inputAvailable(): boolean {
    return typeof fetch === "function";
  }

  get outputAvailable(): boolean {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  snapshot(): NativeVoiceSnapshot {
    return {
      input: { ...this.state.input },
      output: { ...this.state.output },
    };
  }

  async toggleInput(): Promise<NativeVoiceSnapshot> {
    if (this.state.input.state === "listening") {
      const live = this.live;
      this.state = { ...this.state, input: { ...this.state.input, state: "transcribing" } };
      if (live) {
        try {
          await live.stop();
        } catch (cause) {
          this.failInput(cause, this.inputRun);
        }
      }
      return this.snapshot();
    }
    if (this.state.input.state === "preparing" || this.state.input.state === "transcribing") {
      const live = this.live;
      this.inputRun += 1;
      this.live = null;
      await live?.cancel().catch(() => undefined);
      this.state = {
        ...this.state,
        input: { ...this.state.input, state: "idle", partialText: "", unavailableReason: null },
      };
      return this.snapshot();
    }

    this.stopOutput();
    void this.startInput();
    return this.snapshot();
  }

  async speak(text: string): Promise<NativeVoiceSnapshot> {
    const value = text.trim();
    if (!value || !this.outputAvailable) return this.snapshot();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.onstart = () => {
      this.state = { ...this.state, output: { speaking: true } };
    };
    utterance.onend = utterance.onerror = () => {
      this.state = { ...this.state, output: { speaking: false } };
    };
    window.speechSynthesis.speak(utterance);
    this.state = { ...this.state, output: { speaking: true } };
    return this.snapshot();
  }

  async stopOutput(): Promise<NativeVoiceSnapshot> {
    if (this.outputAvailable) window.speechSynthesis.cancel();
    this.state = { ...this.state, output: { speaking: false } };
    return this.snapshot();
  }

  private async startInput(): Promise<void> {
    const run = ++this.inputRun;
    this.state = {
      ...this.state,
      input: {
        ...this.state.input,
        state: "preparing",
        partialText: "",
        unavailableReason: null,
      },
    };

    try {
      let engagement = await engageScoutVoiceDictation({
        surface: "scout-deck",
        requestPermissions: true,
      });
      if (run !== this.inputRun) return;

      if (!engagement.ready && engagement.issue?.code === "microphone_not_requested") {
        await wait(1_800);
        if (run !== this.inputRun) return;
        engagement = await engageScoutVoiceDictation({ surface: "scout-deck" });
      }

      const canAttemptCapture = engagement.ready
        || engagement.issue?.code === "microphone_not_requested";
      if (!canAttemptCapture) {
        this.state = {
          ...this.state,
          input: {
            ...this.state.input,
            state: "unavailable",
            engine: engagement.settings.preference === "apple" ? "apple" : "parakeet",
            modelReady: Boolean(engagement.settings.modelReady),
            unavailableReason: formatScoutVoiceIssue(engagement.issue),
          },
        };
        return;
      }

      const client = getSharedScoutVoiceClient();
      await client.probe({ force: true }).catch(() => false);
      if (run !== this.inputRun) return;

      const live = await client.startLive(
        {
          onState: (next) => this.applyInputState(next, run),
          onPartial: (partialText) => {
            if (run !== this.inputRun) return;
            this.state = {
              ...this.state,
              input: { ...this.state.input, partialText },
            };
          },
        },
        { surface: "scout-deck" },
      );
      if (run !== this.inputRun) {
        await live.cancel().catch(() => undefined);
        return;
      }
      this.live = live;
      this.state = {
        ...this.state,
        input: {
          ...this.state.input,
          state: "listening",
          engine: engagement.settings.preference === "apple" ? "apple" : "parakeet",
          modelReady: Boolean(engagement.settings.modelReady),
          unavailableReason: null,
        },
      };
      void live.result
        .then((final) => this.finishInput(final.text, run))
        .catch((cause) => this.failInput(cause, run));
    } catch (cause) {
      this.failInput(cause, run);
    }
  }

  private applyInputState(next: ScoutVoiceSessionState, run: number): void {
    if (run !== this.inputRun) return;
    const state = next === "recording"
      ? "listening"
      : next === "processing" || next === "done"
        ? "transcribing"
        : next === "cancelled"
          ? "idle"
          : next === "error"
            ? "unavailable"
            : "preparing";
    this.state = { ...this.state, input: { ...this.state.input, state } };
  }

  private finishInput(text: string, run: number): void {
    if (run !== this.inputRun) return;
    this.live = null;
    const finalText = text.trim();
    this.state = {
      ...this.state,
      input: {
        ...this.state.input,
        state: finalText ? "idle" : "unavailable",
        partialText: "",
        finalText: finalText || this.state.input.finalText,
        finalCount: finalText ? this.state.input.finalCount + 1 : this.state.input.finalCount,
        unavailableReason: finalText ? null : "No speech was detected. Tap to try again.",
      },
    };
  }

  private failInput(cause: unknown, run: number): void {
    if (run !== this.inputRun) return;
    this.live = null;
    const message = cause instanceof Error ? cause.message : String(cause);
    const cancelled = cause instanceof Error && cause.name === "AbortError";
    this.state = {
      ...this.state,
      input: {
        ...this.state.input,
        state: cancelled ? "idle" : "unavailable",
        partialText: "",
        unavailableReason: cancelled ? null : message,
      },
    };
  }
}

function readPreferences(): SurfacePreference[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed as SurfacePreference[] : [];
  } catch {
    return [];
  }
}

function browserFormFactor(): SurfaceBootstrap["device"]["formFactor"] {
  const width = Math.min(window.screen.width, window.screen.height);
  if (/iPad/i.test(navigator.userAgent)) return "ipad";
  if (/Mobi|iPhone|Android/i.test(navigator.userAgent) && width < 700) return "phone";
  return width < 1_100 ? "tablet" : "desktop";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `surface-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
