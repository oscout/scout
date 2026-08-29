import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { installScoutSurfacePushReceiver } from "../../surface-contract/native-scout-surface-client.ts";
import { createScoutSurfaceClient } from "../../surface-contract/web-scout-surface-client.ts";
import {
  fetchScoutSpeechCatalog,
  isScoutSpeechStopped,
  playPreparedScoutSpeech,
  prepareScoutSpeech,
  type ScoutSpeechCatalog,
  type ScoutSpeechResult,
} from "../../lib/scout-voice.ts";
import { discoverPreferredDeckLane, prioritizeDeckLane } from "./deck-lane-discovery.ts";
import type {
  CodexDeckBlock,
  CodexDeckRoute,
  CodexDeckSessionReceipt,
  CodexDeckThreadSnapshot,
  FleetAgentSnapshot,
  FleetTailSnapshot,
  NativeVoiceSnapshot,
  SurfaceAgent,
  SurfaceBootstrap,
  SurfaceHost,
  SurfaceTailEvent,
  ScoutSurfaceClient,
} from "../../surface-contract/scout-surface-contract.ts";

export type DeckLane = SurfaceAgent & {
  key: string;
  hostId: string;
  hostName: string;
  events: readonly SurfaceTailEvent[];
};

export type DeckConnection = "waiting" | "ready" | "partial" | "offline" | "error";
export type DeckView = "thread" | "signal";
export type DeckHostScope = "all" | string;
export type DeckSignalTone = "live" | "ready" | "attention" | "quiet";

/**
 * THESIS: Deck is the cockpit for moving a workspace from observable to operable.
 * OWN-WORLD: Scout owns session launch, routing, and the Codex app-server link.
 * STORY: Pick a lane, start Codex when needed, then speak or type into that session.
 * FIRST VIEWPORT: One truthful state line and one obvious next action carry the handoff.
 * FORM: Preserve the dense graphite control-room grammar; add no modal or parallel flow.
 */

/**
 * The turn lifecycle the operator actually reasons about. It merges three
 * separate truths — does this lane have a native adapter, is its thread bound,
 * and is a turn in flight — into one ordered state so the Deck never has to
 * imply progress it cannot observe.
 */
export type DeckTurnPhase =
  | "unavailable"
  | "starting"
  | "cold"
  | "linking"
  | "failed"
  | "ready"
  | "sending"
  | "running"
  | "stopping";

/** Locally-known intent awaiting host confirmation. Never rendered as fact. */
type DeckPending = { kind: "connecting" | "sending" | "stopping"; at: number };

/** A single broker launch, scoped to the lane whose workspace authorized it. */
type DeckSessionLaunch = {
  sourceKey: string;
  sourceName: string;
  receipt: CodexDeckSessionReceipt | null;
  error: string | null;
};

/**
 * The four controller treatments. They are separate interaction models over
 * one controller: the same snapshot, the same lifecycle, the same host calls.
 */
export const DECK_TREATMENTS = ["ops", "yoke", "console", "brief"] as const;
export type DeckTreatment = (typeof DECK_TREATMENTS)[number];

export const DECK_TREATMENT_META: Record<DeckTreatment, { label: string; tagline: string }> = {
  ops: { label: "Ops", tagline: "Agent operations · routed control" },
  yoke: { label: "Yoke", tagline: "Two-grip cockpit · thumb-anchored" },
  console: { label: "Console", tagline: "Fleet board · one command bar" },
  brief: { label: "Brief", tagline: "Single column · command palette" },
};

/** How long an unconfirmed local intent may claim the lifecycle before we admit it. */
const PENDING_TIMEOUT_MS = 9_000;

const HOST_SCOPE_STORAGE_KEY = "scout.deck.hostScope";
const LANE_STORAGE_KEY = "scout.deck.lane.v1";
// v2 promotes the reference-led Ops surface to the default. Versioning the
// preference prevents a remembered exploratory treatment from hiding it after
// an app update; the next explicit choice is remembered normally.
const TREATMENT_STORAGE_KEY = "scout.deck.treatment.v2";
const AUTO_SEND_STORAGE_KEY = "scout.deck.autoSend";
const VOICE_OUT_STORAGE_KEY = "scout.deck.voiceOut";
const VOICE_MODEL_STORAGE_KEY = "scout.deck.voiceModel";
const VOICE_ID_STORAGE_KEY = "scout.deck.voiceId";
const VOICE_SPEED_STORAGE_KEY = "scout.deck.voiceSpeed";

const DEFAULT_VOICE_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE_ID = "alloy";
const DEFAULT_VOICE_SPEED = 1;

/** Bins in the dictation activity trace, sampled at TRACE_INTERVAL_MS. */
const TRACE_BINS = 44;
const TRACE_INTERVAL_MS = 160;

declare global {
  interface Window {
    __scoutSurfaceBootstrap?: Partial<SurfaceBootstrap>;
  }
}

const PREVIEW_HOSTS: SurfaceHost[] = [
  { id: "air", name: "MacBook Air", state: "connected" },
  { id: "studio", name: "Studio", state: "connected" },
];

const now = Date.now();
const PREVIEW_LANES: DeckLane[] = [
  previewLane("air", "MacBook Air", "01", "OpenScout", "codex", "gpt-5.6", "active", "~/dev/openscout", [
    ["tool", "Verifying the native surface bundle", "bun run build:native-surfaces"],
    ["think", "Mapping Deck to Scout's Codex session", "Session state stays binary-native and host-scoped."],
    ["message", "Controller contract is live.", "Start, steer, and interrupt map directly to the selected thread."],
  ]),
  previewLane("studio", "Studio", "02", "SpeakEasy", "claude", "opus-5", "active", "~/dev/SpeakEasy", [
    ["message", "Control deck reference review", "Channel bank, focused stage, and restrained signal color."],
    ["tool", "Captured iPad landscape states", "Connected, partial, and offline."],
    ["think", "Keep harness semantics explicit", "A future Claude adapter can earn its own control vocabulary."],
  ]),
  previewLane("air", "MacBook Air", "03", "Hudson", "claude", "sonnet-5", "waiting", "~/dev/hudson", [
    ["message", "Waiting for operator review", "One navigation decision needs attention."],
    ["note", "Candidate build is ready", "No active tool call."],
  ]),
  previewLane("studio", "Studio", "04", "Release", "codex", "gpt-5.4", "idle", "~/dev/openscout", [
    ["system", "Last run completed", "Checks passed 18 minutes ago."],
  ]),
];

const PREVIEW_THREAD: CodexDeckThreadSnapshot = {
  adapter: "codex_app_server",
  agentId: "01",
  threadId: "019fa45a-scout-deck",
  turnId: "turn_8d17",
  state: "running",
  capabilities: {
    connect: true,
    start: true,
    steer: true,
    interrupt: true,
    queue: false,
    approvals: false,
  },
  capabilityNotes: {
    queue: "A Scout-managed Codex session runs one active turn at a time; Deck does not invent a client-side queue.",
    approvals: "Approval prompts remain runtime-owned and are not actionable from Deck yet.",
  },
  snapshot: {
    session: {
      id: "019fa45a-scout-deck",
      name: "Rework the Deck turn flow",
      adapterType: "codex",
      status: "active",
      cwd: "/Users/arach/dev/openscout",
      model: "gpt-5.6",
      providerMeta: { threadId: "019fa45a-scout-deck" },
    },
    currentTurnId: "turn_8d17",
    turns: [
      {
        id: "turn_8d11",
        status: "completed",
        startedAt: now - 214_000,
        endedAt: now - 176_000,
        isUserTurn: true,
        blocks: [{
          status: "completed",
          block: {
            id: "input_8d11",
            turnId: "turn_8d11",
            type: "text",
            status: "completed",
            index: 0,
            text: "Make Deck operate on the selected Scout-managed Codex session directly.",
          },
        }],
      },
      {
        id: "turn_8d15",
        status: "completed",
        startedAt: now - 164_000,
        endedAt: now - 71_000,
        isUserTurn: false,
        blocks: [
          {
            status: "completed",
            block: {
              id: "reason_8d15",
              turnId: "turn_8d15",
              type: "reasoning",
              status: "completed",
              index: 0,
              text: "Tracing the trusted bridge to Scout's broker-managed Codex session.",
            },
          },
          {
            status: "completed",
            block: {
              id: "tool_8d15",
              turnId: "turn_8d15",
              type: "action",
              status: "completed",
              index: 1,
              action: {
                kind: "command",
                status: "completed",
                command: "bun run build:native-surfaces",
                output: "native surfaces validated",
              },
            },
          },
          {
            status: "completed",
            block: {
              id: "text_8d15",
              turnId: "turn_8d15",
              type: "text",
              status: "completed",
              index: 2,
              text: "The control path is separated from Scout messaging and keeps Codex semantics visible.",
            },
          },
        ],
      },
      {
        id: "turn_8d17",
        status: "streaming",
        startedAt: now - 43_000,
        isUserTurn: false,
        blocks: [
          {
            status: "streaming",
            block: {
              id: "reason_8d17",
              turnId: "turn_8d17",
              type: "reasoning",
              status: "streaming",
              index: 0,
              text: "Refining the controller hierarchy for iPad landscape.",
            },
          },
          {
            status: "streaming",
            block: {
              id: "tool_8d17",
              turnId: "turn_8d17",
              type: "action",
              status: "streaming",
              index: 1,
              action: {
                kind: "command",
                status: "running",
                command: "bun test scout-surface-contract",
                output: "running focused contract checks…",
              },
            },
          },
        ],
      },
    ],
  },
};

const PREVIEW_VOICE: NativeVoiceSnapshot = {
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

const PREVIEW_SPEECH_CATALOG: ScoutSpeechCatalog = {
  defaultModelId: DEFAULT_VOICE_MODEL,
  defaultVoiceId: DEFAULT_VOICE_ID,
  source: "vox",
  models: [
    { id: DEFAULT_VOICE_MODEL, name: "GPT-4o mini TTS", provider: "openai", available: true },
    { id: "eleven_multilingual_v2", name: "Eleven Multilingual v2", provider: "elevenlabs", available: true },
  ],
  voices: [
    { id: "alloy", name: "Alloy", provider: "openai", modelId: DEFAULT_VOICE_MODEL, available: true, isDefault: true },
    { id: "coral", name: "Coral", provider: "openai", modelId: DEFAULT_VOICE_MODEL, available: true, isDefault: false },
    { id: "fable", name: "Fable", provider: "openai", modelId: DEFAULT_VOICE_MODEL, available: true, isDefault: false },
    { id: "nova", name: "Nova", provider: "openai", modelId: DEFAULT_VOICE_MODEL, available: true, isDefault: false },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Aria", provider: "elevenlabs", modelId: "eleven_multilingual_v2", available: true, isDefault: true },
  ],
};

export type DeckSpeechOutputPhase = "idle" | "preparing" | "speaking";

export type DeckModel = ReturnType<typeof useDeckController>;

export function resolveInitialTreatment(search: URLSearchParams): DeckTreatment {
  const requested = search.get("treatment");
  if (isTreatment(requested)) return requested;
  const remembered = localStorage.getItem(TREATMENT_STORAGE_KEY);
  if (isTreatment(remembered)) return remembered;
  return "ops";
}

function isTreatment(value: string | null): value is DeckTreatment {
  return value != null && (DECK_TREATMENTS as readonly string[]).includes(value);
}

/** `?lane=3` opens the third sample lane. Preview only; never consulted live. */
function previewLaneIndex(search: URLSearchParams): number {
  const requested = Number(search.get("lane"));
  if (!Number.isInteger(requested)) return 0;
  return Math.min(Math.max(requested - 1, 0), PREVIEW_LANES.length - 1);
}

/**
 * One controller, four treatments. Everything a treatment can render or drive
 * is derived here so no layout can invent a state the host never reported.
 */
export function useDeckController() {
  const search = new URLSearchParams(window.location.search);
  const preview = search.get("preview") === "1";
  const requestedAgentId = search.get("agent")?.trim() || null;
  const initialVoice = preview && search.get("voice") === "listening"
    ? {
      ...PREVIEW_VOICE,
      input: {
        ...PREVIEW_VOICE.input,
        state: "listening" as const,
        partialText: "Make voice the fastest path into this active turn.",
      },
    }
    : PREVIEW_VOICE;
  const [bootstrap, setBootstrap] = useState<Partial<SurfaceBootstrap> | null>(
    () => window.__scoutSurfaceBootstrap ?? null,
  );
  const [treatment, setTreatmentState] = useState<DeckTreatment>(() => resolveInitialTreatment(search));
  const [lanes, setLanes] = useState<DeckLane[]>(preview ? PREVIEW_LANES : []);
  const [hostScope, setHostScope] = useState<DeckHostScope>("all");
  // Preview-only entry points so a specific state can be opened directly (and
  // captured) without pretending any of it came from a host.
  const [selectedKey, setSelectedKey] = useState<string | null>(
    preview
      ? PREVIEW_LANES[previewLaneIndex(search)]?.key ?? PREVIEW_LANES[0]?.key ?? null
      : localStorage.getItem(LANE_STORAGE_KEY),
  );
  const [connection, setConnection] = useState<DeckConnection>(preview ? "ready" : "waiting");
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<CodexDeckThreadSnapshot | null>(preview ? PREVIEW_THREAD : null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sessionLaunch, setSessionLaunchState] = useState<DeckSessionLaunch | null>(null);
  const [command, setCommand] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<DeckPending | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [view, setView] = useState<DeckView>("thread");
  const [voice, setVoice] = useState<NativeVoiceSnapshot>(initialVoice);
  const [voiceHydrated, setVoiceHydrated] = useState(preview);
  const [voiceOutEnabled, setVoiceOutEnabled] = useState(() => localStorage.getItem(VOICE_OUT_STORAGE_KEY) !== "off");
  const [speechCatalog, setSpeechCatalog] = useState<ScoutSpeechCatalog | null>(preview ? PREVIEW_SPEECH_CATALOG : null);
  const [speechModelId, setSpeechModelId] = useState(
    () => localStorage.getItem(VOICE_MODEL_STORAGE_KEY) || DEFAULT_VOICE_MODEL,
  );
  const [speechVoiceId, setSpeechVoiceId] = useState(
    () => localStorage.getItem(VOICE_ID_STORAGE_KEY) || DEFAULT_VOICE_ID,
  );
  const [speechSpeed, setSpeechSpeedState] = useState(() => {
    const stored = Number(localStorage.getItem(VOICE_SPEED_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 0.5 && stored <= 2 ? stored : DEFAULT_VOICE_SPEED;
  });
  const [speechOutputPhase, setSpeechOutputPhase] = useState<DeckSpeechOutputPhase>("idle");
  const [speechRoute, setSpeechRoute] = useState<Pick<ScoutSpeechResult, "modelId" | "voiceId"> | null>(null);
  const [autoSendOnStop, setAutoSendOnStop] = useState(() => localStorage.getItem(AUTO_SEND_STORAGE_KEY) !== "off");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(preview && search.get("audio") === "open");
  const [inputTrace, setInputTrace] = useState<number[]>(() => Array.from({ length: TRACE_BINS }, () => 0));
  const clientRef = useRef<ScoutSurfaceClient | null>(null);
  const requestedAgentIdRef = useRef(requestedAgentId);
  const selectedKeyRef = useRef(selectedKey);
  const operatorSelectedRef = useRef(false);
  const discoveryStartedRef = useRef(false);
  const seenFinalCountRef = useRef<number | null>(preview ? 0 : null);
  const spokenBlockRef = useRef<string | null>(null);
  const previewVoiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechAbortRef = useRef<AbortController | null>(null);
  const sessionLaunchRef = useRef<DeckSessionLaunch | null>(null);
  /** Dictation started from the primary key sends itself; typed dictation does not. */
  const autoSendRef = useRef(false);
  const listeningSinceRef = useRef<number | null>(null);
  const submitRef = useRef<(text: string) => Promise<void>>(async () => {});
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  selectedKeyRef.current = selectedKey;

  const updateSessionLaunch = (next: DeckSessionLaunch | null) => {
    sessionLaunchRef.current = next;
    setSessionLaunchState(next);
  };

  useEffect(() => {
    installScoutSurfacePushReceiver();
    if (preview) return;

    const client = createScoutSurfaceClient("deck", () => ({
      hostIds: (window.__scoutSurfaceBootstrap?.selectedHostIds ?? []) as [string, ...string[]],
    }));
    clientRef.current = client;
    let cancelled = false;
    let fleetTimer: ReturnType<typeof setInterval> | null = null;
    let refreshingFleet = false;

    void client.bootstrap()
      .then(async (value) => {
        if (cancelled) return;
        window.__scoutSurfaceBootstrap = value;
        setBootstrap(value);
        const hostIds = value.selectedHostIds as [string, ...string[]];
        if (hostIds.length === 0) {
          setConnection("offline");
          setLanes([]);
          return;
        }
        const connectedHostIds = new Set(value.hosts.filter((host) => host.state === "connected").map((host) => host.id));
        const rememberedScope = localStorage.getItem(HOST_SCOPE_STORAGE_KEY);
        const nextScope = rememberedScope === "all" || (rememberedScope && connectedHostIds.has(rememberedScope))
          ? rememberedScope
          : value.focusedHostId && connectedHostIds.has(value.focusedHostId)
            ? value.focusedHostId
            : hostIds[0] ?? "all";
        setHostScope(nextScope);
        const scope = { hostIds };
        const refreshFleet = async () => {
          if (refreshingFleet) return;
          refreshingFleet = true;
          try {
            const [agents, tail] = await Promise.all([
              client.agents.list(scope),
              client.tail.recent(scope),
            ]);
            if (cancelled) return;
            const next = buildDeckLanes(value.hosts, agents, tail);
            const launch = sessionLaunchRef.current;
            const started = launch?.receipt
              ? next.find((lane) => lane.hostId === launch.receipt?.hostId && lane.id === launch.receipt?.agentId)
              : null;
            if (started) {
              const ordered = prioritizeDeckLane(next, started.key);
              setLanes(ordered);
              setSelectedKey(started.key);
              selectedKeyRef.current = started.key;
              operatorSelectedRef.current = true;
              localStorage.setItem(LANE_STORAGE_KEY, started.key);
              setView("thread");
              updateSessionLaunch(null);
            } else {
              const requestedId = requestedAgentIdRef.current;
              requestedAgentIdRef.current = null;
              const requested = requestedId ? next.find((lane) => lane.id === requestedId) : null;
              const rememberedKey = requested?.key ?? selectedKeyRef.current ?? localStorage.getItem(LANE_STORAGE_KEY);
              const remembered = rememberedKey ? next.find((lane) => lane.key === rememberedKey) : null;
              if (remembered) {
                const ordered = prioritizeDeckLane(next, remembered.key);
                setLanes(ordered);
                setSelectedKey(remembered.key);
                selectedKeyRef.current = remembered.key;
                localStorage.setItem(LANE_STORAGE_KEY, remembered.key);
              } else {
                setLanes(next);
                setSelectedKey(null);
                selectedKeyRef.current = null;
                if (!discoveryStartedRef.current) {
                  discoveryStartedRef.current = true;
                  void discoverPreferredDeckLane(next, (route) => client.codex.connect(route))
                    .then((preferredKey) => {
                      if (cancelled || operatorSelectedRef.current) return;
                      const key = preferredKey ?? next[0]?.key ?? null;
                      if (!key) return;
                      setLanes((current) => prioritizeDeckLane(current, key));
                      setSelectedKey(key);
                      selectedKeyRef.current = key;
                      localStorage.setItem(LANE_STORAGE_KEY, key);
                    });
                }
              }
            }
            const failures = agents.hosts.filter((host) => !host.ready).length
              + tail.hosts.filter((host) => !host.ready).length;
            setError(null);
            setConnection(failures > 0 ? "partial" : "ready");
          } catch (cause) {
            if (cancelled) return;
            setError(cause instanceof Error ? cause.message : String(cause));
            setConnection("partial");
          } finally {
            refreshingFleet = false;
          }
        };
        await refreshFleet();
        if (!cancelled) fleetTimer = setInterval(() => void refreshFleet(), 3_000);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setConnection("error");
      });

    return () => {
      cancelled = true;
      if (fleetTimer) clearInterval(fleetTimer);
      clientRef.current = null;
    };
  }, [preview]);

  const hosts = preview ? PREVIEW_HOSTS : bootstrap?.hosts ?? [];
  const scopedLanes = hostScope === "all" ? lanes : lanes.filter((lane) => lane.hostId === hostScope);
  const selected = scopedLanes.find((lane) => lane.key === selectedKey) ?? null;
  const selectedIndex = selected ? scopedLanes.indexOf(selected) : -1;
  const selectedRoute = selected ? { hostId: selected.hostId, agentId: selected.id } satisfies CodexDeckRoute : null;
  const adapterAvailable = Boolean(
    selected?.transport === "codex_app_server"
    && (preview || bootstrap?.capabilities?.includes("codex.thread.snapshot")),
  );
  const voiceAvailable = preview || Boolean(bootstrap?.capabilities?.includes("native.voice.snapshot"));
  const cloudSpeechAvailable = preview || bootstrap?.device?.platform === "web";
  const voiceOutputAvailable = cloudSpeechAvailable
    || Boolean(bootstrap?.capabilities?.includes("native.voice.speak"));

  useEffect(() => {
    if (!cloudSpeechAvailable || preview) return;
    let cancelled = false;
    void fetchScoutSpeechCatalog(speechModelId)
      .then((catalog) => {
        if (cancelled) return;
        setSpeechCatalog(catalog);
        const activeModel = catalog.models.find((model) => model.id === speechModelId);
        if (!activeModel?.available) {
          const nextModel = catalog.models.find((model) => model.id === catalog.defaultModelId && model.available)
            ?? catalog.models.find((model) => model.available);
          if (nextModel && nextModel.id !== speechModelId) {
            setSpeechModelId(nextModel.id);
            localStorage.setItem(VOICE_MODEL_STORAGE_KEY, nextModel.id);
            return;
          }
        }
        const selected = catalog.voices.find((voice) => voice.id === speechVoiceId && voice.available);
        if (selected) return;
        const next = catalog.voices.find((voice) => voice.isDefault && voice.available)
          ?? catalog.voices.find((voice) => voice.available);
        if (!next) return;
        setSpeechVoiceId(next.id);
        localStorage.setItem(VOICE_ID_STORAGE_KEY, next.id);
      })
      .catch((cause) => {
        if (!cancelled) setVoiceError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [cloudSpeechAvailable, preview, speechModelId]);

  useEffect(() => {
    if (!selected) {
      setThread(null);
      return;
    }
    setCommand("");
    setThreadError(null);
    setNotice(null);
    setPending(null);
    autoSendRef.current = false;
    setView(selected.transport === "codex_app_server" ? "thread" : "signal");
    spokenBlockRef.current = null;

    if (preview) {
      setThread(previewThreadFor(selected));
      return;
    }

    const client = clientRef.current;
    if (!client) return;
    setThread(null);
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      await client.native.setLaneSelection({
        hostId: selected.hostId,
        agentId: selected.id,
        ...(selected.conversationId ? { conversationId: selected.conversationId } : {}),
        ...(selected.sessionId ? { sessionId: selected.sessionId } : {}),
      });
      if (cancelled) return;
      if (!adapterAvailable) {
        setThread(null);
        return;
      }

      const refresh = async (connectIfNeeded = false) => {
        try {
          let value = await client.codex.snapshot({ hostId: selected.hostId, agentId: selected.id });
          if (connectIfNeeded && value.state === "disconnected") {
            setPending({ kind: "connecting", at: Date.now() });
            value = await client.codex.connect({ hostId: selected.hostId, agentId: selected.id });
          }
          if (cancelled) return;
          setThread(value);
          setThreadError(null);
        } catch (cause) {
          if (cancelled) return;
          setThreadError(cause instanceof Error ? cause.message : String(cause));
        }
      };
      await refresh(true);
      if (!cancelled) timer = setInterval(() => void refresh(), 2_000);
    })().catch((cause) => {
      if (cancelled) return;
      setThreadError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [selected?.key, adapterAvailable, preview]);

  useEffect(() => {
    if (preview || !voiceAvailable) return;
    const client = clientRef.current;
    if (!client) return;
    let cancelled = false;

    const refreshVoice = async () => {
      try {
        const next = await client.native.voice.snapshot();
        if (!cancelled) {
          setVoice(next);
          setVoiceHydrated(true);
          setVoiceError(null);
        }
      } catch (cause) {
        if (!cancelled) setVoiceError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void refreshVoice();
    const timer = setInterval(() => void refreshVoice(), 320);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [preview, voiceAvailable]);

  useEffect(() => {
    if (!voiceHydrated) return;
    const count = voice.input.finalCount;
    if (seenFinalCountRef.current == null) {
      seenFinalCountRef.current = count;
      return;
    }
    if (count <= seenFinalCountRef.current) return;
    seenFinalCountRef.current = count;
    const finalText = voice.input.finalText.trim();
    const autoSend = autoSendRef.current;
    autoSendRef.current = false;
    if (!finalText) {
      if (autoSend) setNotice("Nothing was transcribed — the turn was not sent.");
      return;
    }
    // Stopping dictation from the primary key is the send gesture. Anything
    // already typed rides along so the operator never loses partial input.
    const merged = appendDictation(command, finalText);
    // Always land the transcript in the composer first. submitTurn clears it
    // only once the send is actually accepted, so a refused or in-flight submit
    // leaves the text on screen instead of dropping it.
    setCommand(merged);
    if (autoSend) void submitRef.current(merged);
  }, [voice.input.finalCount, voice.input.finalText, voiceHydrated, command]);

  useEffect(() => {
    const candidate = latestSpeakableBlock(thread);
    if (!candidate) return;
    if (spokenBlockRef.current == null) {
      spokenBlockRef.current = candidate.id;
      return;
    }
    if (spokenBlockRef.current === candidate.id) return;
    if (!voiceOutEnabled) {
      spokenBlockRef.current = candidate.id;
      return;
    }
    if (voice.input.state === "listening" || voice.input.state === "transcribing") return;

    spokenBlockRef.current = candidate.id;
    if (preview) {
      setVoice((current) => ({ ...current, output: { speaking: true } }));
      if (previewVoiceTimerRef.current) clearTimeout(previewVoiceTimerRef.current);
      previewVoiceTimerRef.current = setTimeout(() => {
        setVoice((current) => ({ ...current, output: { speaking: false } }));
      }, 1_600);
      return;
    }
    if (cloudSpeechAvailable) {
      void speakThroughScout(candidate.text);
      return;
    }
    void clientRef.current?.native.voice.speak(candidate.text)
      .then(setVoice)
      .catch((cause) => setVoiceError(cause instanceof Error ? cause.message : String(cause)));
  }, [thread, voice.input.state, voiceOutEnabled, preview, cloudSpeechAvailable, speechModelId, speechVoiceId, speechSpeed]);

  useEffect(() => () => {
    if (previewVoiceTimerRef.current) clearTimeout(previewVoiceTimerRef.current);
    speechAbortRef.current?.abort();
  }, []);

  const attention = useMemo(
    () => scopedLanes.filter((lane) => lane.state === "waiting" || lane.state === "blocked" || lane.state === "error"),
    [scopedLanes],
  );
  const activeCount = scopedLanes.filter((lane) => isLiveLaneState(lane.state)).length;
  const laneActivity = activityBins(selected?.events ?? []);
  const voiceInputActive = voice.input.state === "listening" || voice.input.state === "transcribing";

  /**
   * The host contract reports no microphone level, so the Deck never draws one.
   * What it can observe is how fast the transcript is arriving; that cadence is
   * shown, and labelled as cadence, so a silent mic never looks like a hot one.
   */
  useEffect(() => {
    if (voice.input.state !== "listening") {
      setInputTrace(Array.from({ length: TRACE_BINS }, () => 0));
      return;
    }
    let lastLength = voiceRef.current.input.partialText.length;
    let walk = 0.45;
    const timer = setInterval(() => {
      let level: number;
      if (preview) {
        // Sample data has no growing transcript; the trace stays a labelled
        // stand-in so the layout can be judged without implying a live mic.
        walk = Math.min(1, Math.max(0.08, walk + (Math.random() - 0.48) * 0.42));
        level = walk;
      } else {
        const length = voiceRef.current.input.partialText.length;
        level = Math.min(1, Math.max(0, length - lastLength) / 5);
        lastLength = length;
      }
      setInputTrace((current) => [...current.slice(1), level]);
    }, TRACE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [voice.input.state, preview]);

  // A local intent only speaks for the lifecycle until the host either confirms
  // it or the window lapses; after that the snapshot is the only source left.
  const livePending = pending && clock - pending.at < PENDING_TIMEOUT_MS ? pending : null;
  const selectedSessionLaunch = sessionLaunch?.sourceKey === selected?.key ? sessionLaunch : null;
  const sessionBusy = Boolean(selectedSessionLaunch && !selectedSessionLaunch.error);
  const sessionError = selectedSessionLaunch?.error ?? null;
  const sessionLaunchAccepted = Boolean(selectedSessionLaunch?.receipt);
  const phase = turnPhase({ adapterAvailable, startingSession: sessionBusy, thread, threadError, pending: livePending });
  const phaseTone = turnPhaseTone(phase);
  const turnStartedAt = activeTurnStartedAt(thread);
  const canTalk = Boolean(voiceAvailable && !threadBusy && (phase === "ready" || phase === "running"));
  const canCompose = Boolean(adapterAvailable && thread && thread.state !== "disconnected" && !threadBusy);
  const canInterrupt = Boolean(adapterAvailable && (phase === "running" || phase === "stopping"));
  /** Rebinding is only offered where connect is the honest next step. */
  const canRebind = Boolean(adapterAvailable && (phase === "cold" || phase === "failed"));
  const canRefresh = Boolean(adapterAvailable && !threadBusy);
  const launchInFlight = Boolean(sessionLaunch && !sessionLaunch.error);
  const sessionStartUnavailableReason = adapterAvailable || !selected
    ? null
    : sessionBusy
      ? sessionLaunchAccepted
        ? "Codex started; Scout is locating its lane."
        : "Scout is starting Codex for this workspace."
      : launchInFlight
        ? `Scout is finishing the Codex launch for ${sessionLaunch?.sourceName ?? "another workspace"}.`
        : !selected.projectRoot
          ? "Scout does not know this lane's workspace."
          : connection !== "ready" && connection !== "partial"
            ? "Reconnect the Scout host to start Codex."
            : !preview && !bootstrap?.capabilities?.includes("codex.session.start")
              ? "This Scout host cannot start Codex from Deck."
              : null;
  const canStartCodexSession = Boolean(!adapterAvailable && selected && !sessionStartUnavailableReason);

  useEffect(() => {
    if (!pending) return;
    // Stop claiming the intent as soon as the snapshot agrees, or the deadline passes.
    const settled = pending.kind === "sending"
      ? thread?.state === "running"
      : pending.kind === "stopping"
        ? thread?.state === "idle"
        : thread?.state === "idle" || thread?.state === "running";
    if (settled) setPending(null);
  }, [pending, thread?.state]);

  const ticking = phase === "running" || phase === "sending" || phase === "stopping" || phase === "linking"
    || phase === "starting"
    || voiceInputActive;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    setClock(Date.now());
    return () => clearInterval(timer);
  }, [ticking]);

  const setTreatment = (next: DeckTreatment) => {
    setTreatmentState(next);
    setSettingsOpen(false);
    localStorage.setItem(TREATMENT_STORAGE_KEY, next);
  };

  const selectLane = (lane: DeckLane) => {
    operatorSelectedRef.current = true;
    selectedKeyRef.current = lane.key;
    setSelectedKey(lane.key);
    localStorage.setItem(LANE_STORAGE_KEY, lane.key);
  };

  /** Lane stepping. Treatments that navigate rather than point rely on this. */
  const stepLane = (delta: number) => {
    if (scopedLanes.length === 0) return;
    const base = selectedIndex < 0 ? 0 : selectedIndex;
    const next = (base + delta + scopedLanes.length) % scopedLanes.length;
    const lane = scopedLanes[next];
    if (lane) selectLane(lane);
  };

  const selectHostScope = (scope: DeckHostScope) => {
    setHostScope(scope);
    setSelectedKey(null);
    localStorage.setItem(HOST_SCOPE_STORAGE_KEY, scope);
  };

  const readSnapshot = async () => {
    if (preview || !selectedRoute || !clientRef.current) return;
    setThread(await clientRef.current.codex.snapshot(selectedRoute));
  };

  /** Operator-driven re-read of the bound task. No state is invented on failure. */
  const refreshSnapshot = async () => {
    if (!selectedRoute || threadBusy) return;
    setNotice(null);
    if (preview) {
      setThread(selected ? previewThreadFor(selected) : null);
      return;
    }
    setThreadBusy(true);
    try {
      await readSnapshot();
      setThreadError(null);
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setThreadBusy(false);
    }
  };

  const connectThread = async () => {
    if (!selectedRoute || threadBusy) return;
    setThreadBusy(true);
    setThreadError(null);
    setNotice(null);
    setPending({ kind: "connecting", at: Date.now() });
    try {
      if (preview) {
        setThread({ ...PREVIEW_THREAD, agentId: selectedRoute.agentId, state: "idle", turnId: null });
      } else if (clientRef.current) {
        setThread(await clientRef.current.codex.connect(selectedRoute));
      }
    } catch (cause) {
      setPending(null);
      setThreadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setThreadBusy(false);
    }
  };

  /** Start a fresh Codex capability for this workspace and put it on Deck. */
  const startCodexSession = async () => {
    if (!selectedRoute || !selected || launchInFlight || !canStartCodexSession) return;
    const launch: DeckSessionLaunch = {
      sourceKey: selected.key,
      sourceName: selected.name,
      receipt: null,
      error: null,
    };
    updateSessionLaunch(launch);
    setNotice(null);
    try {
      if (preview) {
        const previewCodex = PREVIEW_LANES.find((lane) => lane.transport === "codex_app_server");
        if (previewCodex) selectLane(previewCodex);
        updateSessionLaunch(null);
        return;
      }
      const client = clientRef.current;
      const hostIds = bootstrap?.selectedHostIds as [string, ...string[]] | undefined;
      if (!client || !hostIds?.length) throw new Error("No connected Scout host can start Codex.");
      const receipt = await client.codex.startSession(selectedRoute);
      updateSessionLaunch({ ...launch, receipt });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      updateSessionLaunch({ ...launch, error: message });
      if (selectedKeyRef.current === launch.sourceKey) setNotice(message);
    }
  };

  const submitTurn = async (value: string) => {
    const text = value.trim();
    if (!text) return;
    // Refusing is never silent: the text stays in the composer and the operator
    // is told why, so a dictated transcript can always be re-sent by hand.
    if (!selectedRoute || !thread) {
      setNotice("No Codex session is connected — the transcript is still in the composer.");
      return;
    }
    if (threadBusy) {
      setNotice("A turn is already being sent — the transcript is still in the composer.");
      return;
    }
    setThreadBusy(true);
    setThreadError(null);
    setNotice(null);
    setPending({ kind: "sending", at: Date.now() });
    try {
      const mode = thread.state === "running" ? "steer" : "start";
      if (preview) {
        setThread(applyPreviewCommand(thread, text, mode));
      } else if (clientRef.current) {
        if (mode === "steer") await clientRef.current.codex.steer(selectedRoute, text);
        else await clientRef.current.codex.start(selectedRoute, text);
        await new Promise((resolve) => setTimeout(resolve, 180));
        await readSnapshot();
      }
      setCommand("");
    } catch (cause) {
      setPending(null);
      setCommand(text);
      setThreadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setThreadBusy(false);
    }
  };
  submitRef.current = submitTurn;

  const onComposerSubmit = (event?: FormEvent) => {
    event?.preventDefault();
    void submitTurn(command);
  };

  const interruptThread = async () => {
    if (!selectedRoute || !thread || threadBusy) return;
    setThreadBusy(true);
    setThreadError(null);
    setNotice(null);
    setPending({ kind: "stopping", at: Date.now() });
    try {
      if (preview) {
        setThread(applyPreviewInterrupt(thread));
      } else if (clientRef.current) {
        await clientRef.current.codex.interrupt(selectedRoute);
        await new Promise((resolve) => setTimeout(resolve, 180));
        await readSnapshot();
      }
    } catch (cause) {
      setPending(null);
      setThreadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setThreadBusy(false);
    }
  };

  /**
   * The one voice gesture: tap to talk, tap to stop. Whether stopping also sends
   * is an operator setting; the default keeps the single-gesture send.
   */
  const toggleVoiceInput = async () => {
    if (!voiceAvailable) return;
    setVoiceError(null);
    setNotice(null);
    if (voice.input.state !== "listening" && voice.input.state !== "transcribing") {
      speechAbortRef.current?.abort();
      speechAbortRef.current = null;
      setSpeechOutputPhase("idle");
    }
    if (voice.input.state === "listening") {
      autoSendRef.current = autoSendOnStop;
      listeningSinceRef.current = null;
    } else if (voice.input.state === "transcribing") {
      autoSendRef.current = false;
    } else {
      autoSendRef.current = false;
      listeningSinceRef.current = Date.now();
      setClock(Date.now());
    }
    if (preview) {
      if (previewVoiceTimerRef.current) clearTimeout(previewVoiceTimerRef.current);
      if (voice.input.state === "listening") {
        const finalText = voice.input.partialText || "Make the voice loop feel immediate and obvious.";
        setVoice((current) => ({
          ...current,
          input: { ...current.input, state: "transcribing", partialText: "" },
          output: { speaking: false },
        }));
        previewVoiceTimerRef.current = setTimeout(() => {
          setVoice((current) => ({
            ...current,
            input: {
              ...current.input,
              state: "idle",
              finalText,
              finalCount: current.input.finalCount + 1,
            },
          }));
        }, 520);
      } else if (voice.input.state === "transcribing") {
        setVoice((current) => ({ ...current, input: { ...current.input, state: "idle", partialText: "" } }));
      } else {
        setVoice((current) => ({
          ...current,
          input: {
            ...current.input,
            state: "listening",
            partialText: "Make the voice loop feel immediate and obvious.",
            unavailableReason: null,
          },
          output: { speaking: false },
        }));
      }
      return;
    }

    try {
      const next = await clientRef.current?.native.voice.toggleInput();
      if (next) setVoice(next);
    } catch (cause) {
      setVoiceError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  async function speakThroughScout(text: string): Promise<void> {
    speechAbortRef.current?.abort();
    const controller = new AbortController();
    speechAbortRef.current = controller;
    setSpeechOutputPhase("preparing");
    setVoiceError(null);
    try {
      const result = await prepareScoutSpeech(text, {
        modelId: speechModelId,
        voiceId: speechVoiceId,
        speed: speechSpeed,
        originAppId: "openscout-deck",
        utteranceId: `deck-${Date.now()}`,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSpeechRoute({ modelId: result.modelId, voiceId: result.voiceId });
      setSpeechOutputPhase("speaking");
      await playPreparedScoutSpeech(result, { signal: controller.signal });
    } catch (cause) {
      if (!isScoutSpeechStopped(cause)) {
        setVoiceError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (speechAbortRef.current === controller) {
        speechAbortRef.current = null;
        setSpeechOutputPhase("idle");
      }
    }
  }

  const stopSpeaking = async () => {
    if (previewVoiceTimerRef.current) clearTimeout(previewVoiceTimerRef.current);
    speechAbortRef.current?.abort();
    speechAbortRef.current = null;
    setSpeechOutputPhase("idle");
    setVoice((current) => ({ ...current, output: { speaking: false } }));
    if (preview) return;
    try {
      const value = await clientRef.current?.native.voice.stopOutput();
      if (value) setVoice(value);
    } catch (cause) {
      setVoiceError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggleVoiceOutput = async () => {
    const next = !voiceOutEnabled;
    setVoiceOutEnabled(next);
    localStorage.setItem(VOICE_OUT_STORAGE_KEY, next ? "on" : "off");
    if (!next) await stopSpeaking();
  };

  const selectSpeechModel = (modelId: string) => {
    setSpeechModelId(modelId);
    setSpeechCatalog((current) => preview || current?.defaultModelId === modelId ? current : null);
    if (preview) {
      const voiceId = modelId === "eleven_multilingual_v2" ? "9BWtsMINqrJLrRacOk9x" : DEFAULT_VOICE_ID;
      setSpeechVoiceId(voiceId);
      localStorage.setItem(VOICE_ID_STORAGE_KEY, voiceId);
    }
    localStorage.setItem(VOICE_MODEL_STORAGE_KEY, modelId);
  };

  const selectSpeechVoice = (voiceId: string) => {
    setSpeechVoiceId(voiceId);
    localStorage.setItem(VOICE_ID_STORAGE_KEY, voiceId);
  };

  const selectSpeechSpeed = (speed: number) => {
    const next = Math.min(2, Math.max(0.5, speed));
    setSpeechSpeedState(next);
    localStorage.setItem(VOICE_SPEED_STORAGE_KEY, String(next));
  };

  const previewSpeechVoice = () => {
    if (preview) {
      setSpeechOutputPhase("speaking");
      if (previewVoiceTimerRef.current) clearTimeout(previewVoiceTimerRef.current);
      previewVoiceTimerRef.current = setTimeout(() => setSpeechOutputPhase("idle"), 1_400);
      return;
    }
    if (cloudSpeechAvailable) {
      void speakThroughScout("Scout voice out is ready on this Deck.");
      return;
    }
    void clientRef.current?.native.voice.speak("Scout voice out is ready on this Deck.")
      .then(setVoice)
      .catch((cause) => setVoiceError(cause instanceof Error ? cause.message : String(cause)));
  };

  const toggleAutoSend = () => {
    const next = !autoSendOnStop;
    setAutoSendOnStop(next);
    localStorage.setItem(AUTO_SEND_STORAGE_KEY, next ? "on" : "off");
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitTurn(command);
    }
  };

  /** The primary key always holds the single most useful next action. */
  const primaryAction: "start_codex" | "connect" | "talk" = !adapterAvailable
    ? "start_codex"
    : phase === "cold" || phase === "failed"
      ? "connect"
      : "talk";
  const onPrimary = () => {
    if (primaryAction === "start_codex") return void startCodexSession();
    if (primaryAction === "connect") return void connectThread();
    void toggleVoiceInput();
  };

  const displayedVoice = speechOutputPhase === "idle"
    ? voice
    : { ...voice, output: { speaking: true } };

  return {
    preview,
    treatment,
    setTreatment,
    hosts,
    hostScope,
    selectHostScope,
    connection,
    error,
    lanes,
    scopedLanes,
    selected,
    selectedIndex,
    selectLane,
    stepLane,
    attention,
    activeCount,
    laneActivity,
    thread,
    threadBusy,
    threadError,
    sessionBusy,
    sessionError,
    sessionLaunchAccepted,
    sessionStartUnavailableReason,
    notice,
    adapterAvailable,
    voiceAvailable,
    phase,
    phaseTone,
    turnStartedAt,
    clock,
    livePending,
    listeningSince: listeningSinceRef.current,
    canTalk,
    canCompose,
    canInterrupt,
    canRebind,
    canRefresh,
    canStartCodexSession,
    primaryAction,
    onPrimary,
    command,
    setCommand,
    submitTurn,
    onComposerSubmit,
    onComposerKeyDown,
    connectThread,
    startCodexSession,
    refreshSnapshot,
    interruptThread,
    voice: displayedVoice,
    voiceError,
    voiceOutEnabled,
    voiceOutputAvailable,
    cloudSpeechAvailable,
    speechCatalog,
    speechModelId,
    speechVoiceId,
    speechSpeed,
    speechOutputPhase,
    speechRoute,
    selectSpeechModel,
    selectSpeechVoice,
    selectSpeechSpeed,
    previewSpeechVoice,
    toggleVoiceInput,
    toggleVoiceOutput,
    stopSpeaking,
    autoSendOnStop,
    toggleAutoSend,
    inputTrace,
    voiceInputActive,
    settingsOpen,
    setSettingsOpen,
    view,
    setView,
  };
}

export function buildDeckLanes(
  hosts: readonly SurfaceHost[],
  agents: FleetAgentSnapshot,
  tail: FleetTailSnapshot,
): DeckLane[] {
  const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
  const events = new Map<string, SurfaceTailEvent[]>();
  for (const outcome of tail.hosts) {
    if (!outcome.ready) continue;
    for (const event of outcome.value.events) {
      if (!event.agentId) continue;
      const key = `${outcome.hostId}:${event.agentId}`;
      events.set(key, [...(events.get(key) ?? []), event]);
    }
  }
  return agents.hosts.flatMap((outcome) => {
    if (!outcome.ready) return [];
    return outcome.value.agents.map((agent) => ({
      ...agent,
      key: `${outcome.hostId}:${agent.id}`,
      hostId: outcome.hostId,
      hostName: hostNames.get(outcome.hostId) ?? outcome.hostId,
      events: (events.get(`${outcome.hostId}:${agent.id}`) ?? []).sort((a, b) => b.at - a.at),
    }));
  });
}

function previewLane(
  hostId: string,
  hostName: string,
  id: string,
  name: string,
  harness: string,
  model: string,
  state: string,
  projectRoot: string,
  eventSeeds: Array<[SurfaceTailEvent["kind"], string, string]>,
): DeckLane {
  return {
    key: `${hostId}:${id}`,
    hostId,
    hostName,
    id,
    name,
    handle: name.toLowerCase(),
    harness,
    transport: harness === "codex" ? "codex_app_server" : "claude_stream_json",
    model,
    state,
    projectRoot,
    conversationId: `conversation-${id}`,
    sessionId: `session-${id}`,
    updatedAt: now - Number(id) * 43_000,
    events: eventSeeds.map(([kind, text, detail], index) => ({
      id: `${id}-${index}`,
      at: now - index * 68_000 - Number(id) * 12_000,
      agentId: id,
      sessionId: `session-${id}`,
      kind,
      text,
      detail,
    })),
  };
}

function previewThreadFor(lane: DeckLane): CodexDeckThreadSnapshot | null {
  if (lane.transport !== "codex_app_server") return null;
  if (lane.id === "04") {
    return {
      ...PREVIEW_THREAD,
      agentId: lane.id,
      threadId: "019fa45a-release",
      turnId: null,
      state: "idle",
      snapshot: PREVIEW_THREAD.snapshot
        ? { ...PREVIEW_THREAD.snapshot, currentTurnId: null, turns: PREVIEW_THREAD.snapshot.turns.slice(0, 2) }
        : null,
    };
  }
  return PREVIEW_THREAD;
}

function applyPreviewCommand(
  thread: CodexDeckThreadSnapshot,
  text: string,
  mode: "start" | "steer",
): CodexDeckThreadSnapshot {
  const turnId = mode === "steer" ? thread.turnId ?? `turn_${Date.now()}` : `turn_${Date.now()}`;
  const snapshot = thread.snapshot;
  if (!snapshot) return thread;
  const block: CodexDeckBlock = {
    id: `${mode}_${Date.now()}`,
    turnId,
    type: mode === "steer" ? "reasoning" : "text",
    status: "streaming",
    index: 99,
    text: mode === "steer" ? `Steer received: ${text}` : text,
  };
  const turns = mode === "steer"
    ? snapshot.turns.map((turn) => turn.id === turnId
      ? { ...turn, blocks: [...turn.blocks, { status: "streaming", block }] }
      : turn)
    : [...snapshot.turns, {
      id: turnId,
      status: "streaming" as const,
      blocks: [{ status: "streaming", block }],
      startedAt: Date.now(),
      isUserTurn: true,
    }];
  return { ...thread, state: "running", turnId, snapshot: { ...snapshot, currentTurnId: turnId, turns } };
}

function applyPreviewInterrupt(thread: CodexDeckThreadSnapshot): CodexDeckThreadSnapshot {
  if (!thread.snapshot || !thread.turnId) return { ...thread, state: "idle", turnId: null };
  const turns = thread.snapshot.turns.map((turn) => turn.id === thread.turnId
    ? {
      ...turn,
      status: "interrupted" as const,
      endedAt: Date.now(),
      blocks: turn.blocks.map((state) => ({
        ...state,
        status: "completed" as const,
        block: { ...state.block, status: state.block.status === "streaming" ? "completed" : state.block.status },
      })),
    }
    : turn);
  return { ...thread, state: "idle", turnId: null, snapshot: { ...thread.snapshot, currentTurnId: null, turns } };
}

/**
 * Collapses adapter availability, thread binding, and turn state into the one
 * ordered lifecycle the operator sees. Local intent outranks the last snapshot
 * only while it is still within its confirmation window.
 */
function turnPhase({
  adapterAvailable,
  startingSession,
  thread,
  threadError,
  pending,
}: {
  adapterAvailable: boolean;
  startingSession: boolean;
  thread: CodexDeckThreadSnapshot | null;
  threadError: string | null;
  pending: DeckPending | null;
}): DeckTurnPhase {
  if (!adapterAvailable && startingSession) return "starting";
  if (!adapterAvailable) return "unavailable";
  if (threadError) return "failed";
  if (pending?.kind === "sending") return "sending";
  if (pending?.kind === "stopping") return "stopping";
  if (pending?.kind === "connecting") return "linking";
  if (!thread) return "linking";
  if (thread.state === "disconnected") return "cold";
  return thread.state === "running" ? "running" : "ready";
}

export function turnPhaseTone(phase: DeckTurnPhase): DeckSignalTone {
  if (phase === "running" || phase === "sending" || phase === "starting") return "live";
  if (phase === "ready") return "ready";
  if (phase === "cold" || phase === "failed") return "attention";
  return "quiet";
}

export function turnPhaseLabel(phase: DeckTurnPhase, laneState: string | null): string {
  if (phase === "unavailable") return laneStateLabel(laneState);
  if (phase === "starting") return "Starting Codex";
  if (phase === "cold") return "Session offline";
  if (phase === "linking") return "Linking";
  if (phase === "failed") return "Connection failed";
  if (phase === "sending") return "Sending";
  if (phase === "stopping") return "Stopping";
  if (phase === "running") return "Turn running";
  return "Ready";
}

export function turnPhaseDetail(
  phase: DeckTurnPhase,
  thread: CodexDeckThreadSnapshot | null,
  threadError: string | null,
  notice: string | null,
  _lane: DeckLane,
  sessionStartUnavailableReason: string | null = null,
): string {
  if (notice) return notice;
  if (phase === "unavailable") return sessionStartUnavailableReason ?? "Scout sees this lane · Codex not started";
  if (phase === "starting") return sessionStartUnavailableReason ?? "Scout is starting a Codex session for this workspace…";
  if (phase === "failed") return threadError ?? "The host did not answer.";
  if (phase === "cold") return "Connect restores Scout's managed Codex session.";
  if (phase === "linking") return "Connecting to Scout's managed Codex session…";
  if (phase === "sending") return "Waiting for Codex to accept the turn…";
  if (phase === "stopping") return "Interrupt sent; waiting for the turn to end…";
  if (phase === "running") return turnActivityDetail(thread);
  const last = lastCompletedTurnEndedAt(thread);
  return last ? `Idle · last turn ended ${relativeTime(last)} ago` : "Idle · no turns yet in this session";
}

/** Describes what the running turn is doing right now, straight from the snapshot. */
function turnActivityDetail(thread: CodexDeckThreadSnapshot | null): string {
  const turn = activeTurn(thread);
  if (!turn) return "Streaming…";
  for (let index = turn.blocks.length - 1; index >= 0; index -= 1) {
    const state = turn.blocks[index];
    if (!state || state.status !== "streaming") continue;
    if (state.block.type === "action") {
      const label = state.block.action?.command ?? state.block.action?.toolName ?? state.block.action?.path;
      return label ? `Running ${label}` : "Running an action";
    }
    if (state.block.type === "reasoning") return "Thinking";
    if (state.block.type === "text") return "Writing a reply";
  }
  return "Streaming…";
}

function activeTurn(thread: CodexDeckThreadSnapshot | null) {
  const turns = thread?.snapshot?.turns ?? [];
  return turns.find((turn) => turn.id === thread?.turnId) ?? null;
}

function activeTurnStartedAt(thread: CodexDeckThreadSnapshot | null): number | null {
  return activeTurn(thread)?.startedAt ?? null;
}

function lastCompletedTurnEndedAt(thread: CodexDeckThreadSnapshot | null): number | null {
  const turns = thread?.snapshot?.turns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const endedAt = turns[index]?.endedAt;
    if (endedAt) return endedAt;
  }
  return null;
}

export function turnElapsed(model: DeckModel): string {
  const { phase, turnStartedAt, livePending, clock } = model;
  if (phase === "sending" && livePending) return formatElapsed(clock - livePending.at);
  if ((phase === "running" || phase === "stopping") && turnStartedAt) return formatElapsed(clock - turnStartedAt);
  return "";
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function appendDictation(current: string, phrase: string): string {
  const next = phrase.trim();
  if (!next) return current;
  if (!current.trim()) return next;
  return `${current}${/\s$/.test(current) ? "" : " "}${next}`;
}

function latestSpeakableBlock(thread: CodexDeckThreadSnapshot | null): { id: string; text: string } | null {
  const turns = thread?.snapshot?.turns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn || turn.isUserTurn || turn.status !== "completed") continue;
    for (let blockIndex = turn.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const state = turn.blocks[blockIndex];
      const text = state?.block.type === "text" ? blockTitle(state.block) : "";
      if (state?.status === "completed" && text) return { id: state.block.id, text };
    }
  }
  return null;
}

export function threadRows(thread: CodexDeckThreadSnapshot, limit = 9) {
  return (thread.snapshot?.turns ?? []).flatMap((turn) => turn.blocks.map((state) => ({
    role: turn.isUserTurn ? "operator" as const : "codex" as const,
    at: turn.startedAt,
    status: state.status,
    block: state.block,
  }))).filter((row) => Boolean(blockTitle(row.block))).slice(-limit);
}

export function blockTitle(block: CodexDeckBlock): string {
  if (block.type === "action") {
    return block.action?.command
      ?? block.action?.toolName
      ?? block.action?.path
      ?? block.action?.agentName
      ?? "Codex action";
  }
  return block.text?.trim() || block.message?.trim() || "";
}

export function blockDetail(block: CodexDeckBlock): string {
  if (block.type !== "action") return "";
  return block.action?.output?.trim()
    || (block.action?.kind ? `${block.action.kind.replaceAll("_", " ")} · ${block.action.status}` : "");
}

export function connectionLabel(connection: DeckConnection): string {
  if (connection === "ready") return "Host connected";
  if (connection === "partial") return "Host degraded";
  if (connection === "error") return "Host unavailable";
  if (connection === "offline") return "Host disconnected";
  return "Connecting to host";
}

/**
 * Display-only vocabulary for the concrete host integration. Matching
 * predicates keep using the raw backend value.
 */
export function transportLabel(transport: string | null | undefined): string {
  if (!transport) return "transport unreported";
  if (transport === "codex_app_server") return "Scout app-server";
  return transport;
}

/**
 * The same fact as `transportLabel`, sized for a narrow readout column where the
 * long form ellipsises into nothing. It names the channel rather than the thing
 * on the far end of it, which is what a two-word slot can actually carry; the
 * full label stays available as the cell's tooltip.
 */
export function transportShortLabel(transport: string | null | undefined): string {
  if (!transport) return "unreported";
  if (transport === "codex_app_server") return "App server";
  return transport;
}

/** The exact Scout-managed Codex session title reported by the host. */
export function taskTitle(thread: CodexDeckThreadSnapshot | null): string | null {
  const name = thread?.snapshot?.session?.name?.trim();
  return name ? name : null;
}

export function connectionReadout(connection: DeckConnection): string {
  if (connection === "ready") return "online";
  if (connection === "partial") return "degraded";
  if (connection === "error") return "error";
  if (connection === "offline") return "offline";
  return "connecting";
}

export function laneTone(lane: DeckLane): DeckSignalTone {
  if (lane.state === "waiting" || lane.state === "blocked" || lane.state === "error") return "attention";
  if (isLiveLaneState(lane.state)) return "live";
  return "quiet";
}

export function laneStateLabel(state: string | null): string {
  if (isLiveLaneState(state)) return "Agent active";
  if (state === "waiting" || state === "blocked") return "Needs attention";
  if (state === "error") return "Agent error";
  if (state === "idle" || state === "available") return "Idle";
  return state ? state.replaceAll("_", " ") : "Standing by";
}

export function isLiveLaneState(state: string | null): boolean {
  return state === "live" || state === "working" || state === "active" || state === "running" || state === "in_flight";
}

export function relativeTime(at: number | null): string {
  if (!at) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}

export function activityBins(events: readonly SurfaceTailEvent[], count = 28, windowMs = 5 * 60_000): number[] {
  const end = Date.now();
  const start = end - windowMs;
  const bins = Array.from({ length: count }, () => 0);
  for (const event of events) {
    if (event.at < start || event.at > end) continue;
    const index = Math.min(count - 1, Math.floor(((event.at - start) / windowMs) * count));
    bins[index] += event.kind === "message" || event.kind === "ask" ? 2 : 1;
  }
  return bins.map((value) => Math.min(6, value));
}

export function primaryKeyLabel(
  action: "start_codex" | "connect" | "talk",
  phase: DeckTurnPhase,
  state: NativeVoiceSnapshot["input"]["state"],
): string {
  if (action === "start_codex") return phase === "starting" ? "starting" : "start codex";
  if (action === "connect") return phase === "failed" ? "retry" : "connect";
  if (state === "listening") return "send";
  if (state === "transcribing") return "…";
  if (state === "preparing") return "warming";
  if (state === "unavailable") return "voice off";
  if (phase === "linking") return "linking";
  if (phase === "sending") return "sending";
  if (phase === "stopping") return "stopping";
  return phase === "running" ? "steer" : "talk";
}

export function primaryKeyDescription(
  action: "start_codex" | "connect" | "talk",
  phase: DeckTurnPhase,
  state: NativeVoiceSnapshot["input"]["state"],
  sessionStartUnavailableReason: string | null = null,
): string {
  if (action === "start_codex") return phase === "starting"
    ? sessionStartUnavailableReason ?? "Scout is starting a Codex session for this workspace"
    : sessionStartUnavailableReason ?? "Start a Scout-managed Codex session for this workspace";
  if (action === "connect") return "Reconnect Scout's managed Codex session";
  if (state === "listening") return "Stop dictation and send the turn";
  if (state === "transcribing") return "Transcribing dictation";
  return phase === "running" ? "Speak to steer the active turn" : "Speak to start a turn";
}

export function consoleCaption(model: DeckModel): string {
  const { voice, voiceAvailable, phase, listeningSince, clock, sessionError } = model;
  if (!voiceAvailable) return "Native voice becomes available inside the Scout iPad app.";
  if (voice.input.state === "listening") {
    const elapsed = listeningSince ? ` · ${formatElapsed(clock - listeningSince)}` : "";
    return `${voice.input.partialText || "Listening — speak naturally."}${elapsed}`;
  }
  if (voice.input.state === "transcribing") return "Transcribing on device, then sending…";
  if (voice.input.state === "preparing") return "Warming Parakeet; Apple Speech remains available as fallback.";
  if (voice.input.state === "unavailable") return voice.input.unavailableReason || "Microphone access is unavailable.";
  if (sessionError) return sessionError;
  if (phase === "starting") return model.sessionLaunchAccepted
    ? "Codex started; waiting for its Scout lane."
    : "Scout is starting Codex.";
  if (phase === "unavailable") return model.canStartCodexSession
    ? "Voice becomes available with the Codex session."
    : model.sessionStartUnavailableReason ?? "Codex launch is unavailable for this lane.";
  if (phase === "cold" || phase === "failed") return "Reconnect the Codex session before talking to it.";
  if (phase === "running") return "Tap to talk, tap again to steer the running turn.";
  return "Tap to talk, tap again to send.";
}

export function voiceReadout(state: NativeVoiceSnapshot["input"]["state"]): string {
  if (state === "listening") return "listening";
  if (state === "transcribing") return "processing";
  if (state === "preparing") return "warming";
  if (state === "unavailable") return "blocked";
  return "ready";
}

export function composerPlaceholder(
  phase: DeckTurnPhase,
  voiceState: NativeVoiceSnapshot["input"]["state"],
): string {
  if (phase === "starting") return "Composer unlocks when the Codex lane appears.";
  if (phase === "unavailable") return "Composer unlocks with a Codex session.";
  if (phase === "cold" || phase === "failed") return "Reconnect the Codex session to enable typing.";
  if (voiceState === "listening") return "Speaking… the transcript sends when you tap send.";
  if (voiceState === "transcribing") return "Finishing your transcript…";
  return phase === "running" ? "Or type a redirect for this active turn…" : "Or type what this session should do next…";
}
