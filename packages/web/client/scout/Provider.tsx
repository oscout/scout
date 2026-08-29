import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useOptionalFlag } from "hudsonkit/flags";
import { useOptionalTheme } from "hudsonkit/theme";
import {
  useRouter,
  type NavigateOptions,
} from "../lib/router.ts";
import { api } from "../lib/api.ts";
import { friendlyApiError, isOfflineApiError } from "../lib/api-errors.ts";
import { useBrokerEvents } from "../lib/sse.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../lib/surface-activity.ts";
import { isAgentOnline } from "../lib/agent-state.ts";
import { readCachedOperatorName, writeCachedOperatorName } from "../lib/operator-identity.ts";
import {
  forwardScoutbotUiActionToNativeHost,
  resolveScoutbotAgent,
  resolveScoutbotAgentId,
  type ScoutbotUiAction,
} from "../lib/scoutbot.ts";
import { ContextMenuProvider } from "../components/ContextMenu.tsx";
import { FilePreviewOverlay } from "./FilePreviewOverlay.tsx";
import { ScoutbotStateProvider } from "./scoutbot/ScoutbotStateContext.tsx";
import { ScoutbotRealtimeVoiceProvider } from "./scoutbot/ScoutbotRealtimeVoiceContext.tsx";
import { ContextCaptureHost } from "./ContextCaptureHost.tsx";
import type { Agent, BrokerRouteAttempt, Route } from "../lib/types.ts";
import type { ScoutAppearanceDetails, ScoutTheme } from "../lib/theme.ts";
import {
  applyScoutThemeToDocument,
  migrateLegacyAgentCharacters,
  SCOUT_THEME_STORAGE_KEY,
  resolveScoutStartupAppearanceDetails,
  resolveScoutNativeThemeVars,
  writeScoutAppearanceDetails,
} from "../lib/theme.ts";
import type { KnowledgeHit, SearchFilters } from "../lib/knowledge-search.ts";
import type { FocusedSession } from "../lib/session-catalog.ts";
import type {
  ContextCaptureIntent,
  ForwardContextMode,
  ForwardContextSource,
} from "../lib/context-capture-draft.ts";
import { SCOUT_REALTIME_VOICE_FLAG } from "../../shared/realtime-voice.ts";

declare global {
  interface Window {
    scoutScoutbot?: {
      applyUiAction: (action: ScoutbotUiAction) => void;
      navigate: (route: Route) => void;
    };
  }
}

export interface OnboardingState {
  hasLocalConfig: boolean;
  hasProjectConfig: boolean;
  hasOperatorName: boolean;
  localConfigPath: string | null;
  projectRoot: string | null;
  projectConfigPath?: string | null;
  currentDirectory: string | null;
  contextRoot?: string | null;
  sourceRoots?: string[];
  defaultHarness?: string;
  operatorName: string | null;
  operatorNameSuggestion: string | null;
  brokerReachable?: boolean;
  hasReadyRuntime?: boolean;
  readyRuntimeCount?: number;
  skippedAt?: number | null;
  completedAt?: number | null;
  needed?: boolean;
}

export interface ScoutContextValue {
  route: Route;
  navigate: (r: Route, options?: NavigateOptions) => void;
  navigateBack: () => void;
  canNavigateBack: boolean;

  agents: Agent[];
  agentsLoaded: boolean;
  onlineCount: number;
  apiConnection: ApiConnectionState;

  appearanceDetails: ScoutAppearanceDetails;
  updateAppearanceDetails: (patch: Partial<ScoutAppearanceDetails>) => void;

  reload: () => Promise<void>;

  onboarding: OnboardingState | null;
  /** The operator's name, seeded from the last visit so it is never blank on
   *  the first frame. `null` only on a genuine first load. */
  operatorName: string | null;
  refreshOnboarding: () => Promise<void>;
  onboardingSkipped: boolean;
  skipOnboarding: () => void;

  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  scoutbotAgentId: string;
  scoutbotConversationId: string | null;
  applyScoutbotUiAction: (action: ScoutbotUiAction) => void;

  selectedBrokerAttempt: BrokerRouteAttempt | null;
  inspectBrokerAttempt: (attempt: BrokerRouteAttempt) => void;
  clearBrokerAttempt: () => void;
  selectedKnowledgeHit: KnowledgeHit | null;
  selectedKnowledgeQuery: string;
  inspectKnowledgeHit: (hit: KnowledgeHit, query?: string, filters?: SearchFilters) => void;
  clearKnowledgeHit: () => void;
  // The agent-profile session the center is exploring; the rail follows it so
  // its session info + secondary actions track the center's selection.
  focusedSession: FocusedSession | null;
  focusSession: (agentId: string, sessionId: string) => void;

  openFilePreview: (path: string) => void;
  closeFilePreview: () => void;

  openContextCapture: (request?: ContextCaptureRequest) => void;
  closeContextCapture: () => void;
}

export type ContextCaptureRequest = {
  intent: ContextCaptureIntent;
  agentId?: string;
  conversationId?: string;
  projectPath?: string;
  message?: string;
  files?: File[];
  attachmentFeedback?: string;
  preferExistingChat?: boolean;
  forwardContext?: ForwardContextSource;
  forwardContextMode?: ForwardContextMode;
};

export type ApiConnectionState = {
  status: "checking" | "online" | "degraded" | "offline";
  message: string | null;
  lastCheckedAt: number | null;
};

// Exported so the design-sync preview provider (client/_ds/) can supply a mock
// ScoutContext to context-coupled components (e.g. AgentsLibrary) without the
// full ScoutProvider chrome. No behavior change for the app.
export const ScoutContext = createContext<ScoutContextValue | null>(null);

const AGENT_REFRESH_EVENT_KINDS = [
  "hello",
  "node.upserted",
  "actor.registered",
  "agent.registered",
  "agent.endpoint.upserted",
  "invocation.requested",
  "flight.updated",
  "delivery.state.changed",
  "scout.dispatched",
] as const;
const AGENT_REFRESH_EVENT_KIND_SET = new Set<string>(AGENT_REFRESH_EVENT_KINDS);
const AGENT_REFRESH_POLL_MS = 30_000;
const AGENT_REFRESH_EVENT_DEBOUNCE_MS = 250;

type ThemeVars = CSSProperties & Record<`--${string}`, string>;

function keepPreviousIfJsonEqual<T>(previous: T, next: T): T {
  try {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  } catch {
    return next;
  }
}

// Exported for the design-sync lightweight preview provider (client/_ds/) — it
// reuses these vars so cards render on the real dark theme. No behavior change.
export const DARK_THEME_VARS: ThemeVars = {
  "--hud-bg": "oklch(0.118 0.004 260)",
  "--hud-surface": "oklch(0.205 0.005 260)",
  "--hud-ink": "oklch(0.975 0.006 260)",
  "--hud-muted": "oklch(0.80 0.008 260)",
  "--hud-dim": "oklch(0.70 0.007 260)",
  "--hud-border": "oklch(0.975 0.006 260 / 0.08)",
  "--hud-accent": "oklch(0.86 0.17 125)",
  "--hud-accent-soft": "oklch(0.86 0.17 125 / 0.08)",
  "--hud-shadow-soft": "oklch(0.08 0.004 260 / 0.42)",
  "--hud-chrome-border": "oklch(0.975 0.006 260 / 0.04)",
  "--hud-shadow-panel": "0 12px 34px oklch(0.08 0.004 260 / 0.45)",
  "--hud-shadow-panel-hover": "0 14px 38px oklch(0.08 0.004 260 / 0.52)",
  "--hud-shadow-bar": "0 -10px 28px oklch(0.08 0.004 260 / 0.38)",
  "--hud-shadow-nav": "0 8px 24px oklch(0.08 0.004 260 / 0.32)",
  "--hud-shadow-minimap": "0 10px 24px oklch(0.08 0.004 260 / 0.38)",
  "--hud-status-ok": "oklch(0.80 0.15 155)",
  "--hud-status-warn": "oklch(0.82 0.15 85)",
  "--hud-status-error": "oklch(0.72 0.18 25)",
  /* HudsonKit's Tailwind utilities (`bg-background`, `text-foreground`, used by
   * chrome/Frame) read raw OKLCH channels via `oklch(var(--background))`, a
   * layer separate from the --hud-* tokens above. HudsonKit only flips them
   * under [data-hudson-template][data-hudson-theme], a pair Scout never sets,
   * so Frame's full-viewport plane stayed dark in light mode while content
   * inherited light inks — dark-on-dark rails. Point the channels at Scout's
   * own canvas/ink instead of adopting HudsonKit's cool light (hue 213), which
   * would put a second white next to Scout's warm paper. */
  "--background": "0.132 0.004 260",
  "--foreground": "0.965 0.006 260",
  "--card": "0.178 0.005 260",
  "--card-foreground": "0.965 0.006 260",
  "--popover": "0.178 0.005 260",
  "--popover-foreground": "0.965 0.006 260",
  "--muted-foreground": "0.72 0.008 260",
  // Scout semantic colors (web-only; no HudsonKit equivalent).
  "--scrim": "rgba(0, 0, 0, 0.5)",
  "--scrim-soft": "rgba(0, 0, 0, 0.3)",
  "--info": "#62b6ff",
  "--shadow-card": "0 8px 22px rgba(0, 0, 0, 0.22)",
  "--shadow-card-hover": "0 14px 36px rgba(0, 0, 0, 0.30)",
  // Categorical / brand accents — distinct from status colors, do not flatten.
  "--cat-gold": "#d7a978",
  "--cat-purple": "#c58cff",
  "--cat-sky": "#38bdf8",
  "--scout-chrome-ink-strong": "color-mix(in srgb, var(--hud-ink) 94%, transparent)",
  "--scout-chrome-ink": "color-mix(in srgb, var(--hud-ink) 84%, transparent)",
  "--scout-chrome-ink-soft": "color-mix(in srgb, var(--hud-ink) 68%, transparent)",
  /* Secondary chrome text: keep hierarchy, but stay readable on near-black. */
  "--scout-chrome-ink-faint": "color-mix(in srgb, var(--hud-ink) 64%, transparent)",
  "--scout-chrome-ink-ghost": "color-mix(in srgb, var(--hud-ink) 56%, transparent)",
  "--scout-chrome-hover": "color-mix(in srgb, var(--hud-ink) 5%, transparent)",
  "--scout-chrome-active": "color-mix(in srgb, var(--hud-ink) 9%, transparent)",
  "--scout-chrome-border-soft": "color-mix(in srgb, var(--hud-ink) 8%, transparent)",
  "--scout-chrome-avatar-ink": "#111111",
  "--hud-font-sans": "'Inter', ui-sans-serif, system-ui, sans-serif",
  "--hud-font-mono": "'JetBrains Mono', ui-monospace, Menlo, monospace",
  "--hud-font-serif": "'Spectral', 'Cormorant Garamond', Georgia, serif",
  "--hud-font-accent-title": "'Inter Tight', var(--hud-font-sans)",
};

export const LIGHT_THEME_VARS: ThemeVars = {
  // Paper neutrals: keep warm hue (~78) and a little chroma so muted/dim
  // read as taupe/ink, not cool slate gray (Repos empty-state critique).
  "--hud-bg": "oklch(0.982 0.008 78)",
  "--hud-surface": "oklch(0.994 0.006 78)",
  "--hud-ink": "oklch(0.26 0.018 72)",
  "--hud-muted": "oklch(0.50 0.028 70)",
  "--hud-dim": "oklch(0.64 0.022 72)",
  "--hud-border": "oklch(0.86 0.016 75 / 0.92)",
  "--hud-accent": "oklch(0.72 0.16 125)",
  "--hud-accent-soft": "oklch(0.72 0.16 125 / 0.11)",
  "--hud-shadow-soft": "oklch(0.42 0.02 70 / 0.11)",
  "--hud-status-ok": "oklch(0.64 0.16 155)",
  "--hud-status-warn": "oklch(0.72 0.15 85)",
  "--hud-status-error": "oklch(0.62 0.19 25)",
  /* See DARK_THEME_VARS: raw channels behind HudsonKit's Tailwind utilities,
   * held on Scout's warm paper canvas rather than HudsonKit's cool light. */
  "--background": "0.978 0.004 85",
  "--foreground": "0.24 0.01 80",
  "--card": "0.992 0.003 85",
  "--card-foreground": "0.24 0.01 80",
  "--popover": "0.992 0.003 85",
  "--popover-foreground": "0.24 0.01 80",
  "--muted-foreground": "0.56 0.014 80",
  // Scout semantic colors (web-only; no HudsonKit equivalent).
  "--scrim": "rgba(28, 24, 20, 0.30)",
  "--scrim-soft": "rgba(28, 24, 20, 0.16)",
  "--info": "#2f7fd6",
  "--shadow-card": "0 8px 22px oklch(0.42 0.02 70 / 0.09)",
  "--shadow-card-hover": "0 14px 36px oklch(0.42 0.02 70 / 0.13)",
  // Categorical / brand accents — distinct from status colors, do not flatten.
  "--cat-gold": "#a9824f",
  "--cat-purple": "#8b5cf6",
  "--cat-sky": "#0ea5e9",
  "--scout-chrome-ink-strong": "color-mix(in srgb, var(--hud-ink) 94%, transparent)",
  "--scout-chrome-ink": "color-mix(in srgb, var(--hud-ink) 78%, transparent)",
  "--scout-chrome-ink-soft": "color-mix(in srgb, var(--hud-ink) 60%, transparent)",
  /* SCO-085: raise secondary text from ~35% to ~55–60% for sidebar/rail/lanes. */
  "--scout-chrome-ink-faint": "color-mix(in srgb, var(--hud-ink) 56%, transparent)",
  "--scout-chrome-ink-ghost": "color-mix(in srgb, var(--hud-ink) 50%, transparent)",
  "--scout-chrome-hover": "color-mix(in srgb, var(--hud-ink) 4%, transparent)",
  "--scout-chrome-active": "color-mix(in srgb, var(--hud-ink) 8%, transparent)",
  "--scout-chrome-border-soft": "color-mix(in srgb, var(--hud-border) 80%, transparent)",
  "--scout-chrome-avatar-ink": "#ffffff",
  "--hud-font-sans": "'Inter', ui-sans-serif, system-ui, sans-serif",
  "--hud-font-mono": "'JetBrains Mono', ui-monospace, Menlo, monospace",
  "--hud-font-serif": "'Spectral', 'Cormorant Garamond', Georgia, serif",
  "--hud-font-accent-title": "'Inter Tight', var(--hud-font-sans)",
};

const HUDSON_MANAGED_THEME_VARS = new Set([
  "--hud-bg",
  "--hud-surface",
  "--hud-ink",
  "--hud-muted",
  "--hud-dim",
  "--hud-border",
  "--hud-accent",
  "--hud-accent-soft",
  "--hud-shadow-soft",
  "--hud-chrome-border",
  "--hud-shadow-panel",
  "--hud-shadow-panel-hover",
  "--hud-shadow-bar",
  "--hud-shadow-nav",
  "--hud-shadow-minimap",
  "--hud-status-ok",
  "--hud-status-warn",
  "--hud-status-error",
]);

function scoutThemeAugmentVars(theme: ScoutTheme): ThemeVars {
  const source = theme === "light" ? LIGHT_THEME_VARS : DARK_THEME_VARS;
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !HUDSON_MANAGED_THEME_VARS.has(key)),
  ) as ThemeVars;
}

export function useOptionalScout() {
  return useContext(ScoutContext);
}

export function useScout() {
  const ctx = useContext(ScoutContext);
  if (!ctx) throw new Error("useScout must be used inside ScoutProvider");
  return ctx;
}

export function ScoutProvider({
  children,
  initialTheme = "dark",
}: {
  children: ReactNode;
  initialTheme?: ScoutTheme;
}) {
  const { route, navigate, navigateBack, canNavigateBack } = useRouter();
  const hudsonTheme = useOptionalTheme();
  const realtimeVoiceEnabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, true);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [apiConnection, setApiConnection] = useState<ApiConnectionState>({
    status: "checking",
    message: null,
    lastCheckedAt: null,
  });
  const [appearanceDetails, setAppearanceDetails] = useState<ScoutAppearanceDetails>(
    resolveScoutStartupAppearanceDetails,
  );
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  /** True while `onboarding` holds the unreachable-API placeholder. */
  const onboardingStaleRef = useRef(false);
  /**
   * Who you are, available on the first frame.
   *
   * Kept beside `onboarding` rather than inside it on purpose: seeding the
   * onboarding record itself would mean guessing `hasOperatorName`, and a
   * wrong guess there suppresses the setup flow for someone who still needs
   * it. A name is safe to be optimistic about; a completed-setup claim is not.
   */
  const [operatorName, setOperatorName] = useState<string | null>(readCachedOperatorName);
  const [onboardingSkipped, setOnboardingSkipped] = useState(false);
  // Selection objects are cached for immediate inspector payload; the URL is
  // the durable source of truth for attempt/hit/session ids (SCO-082 Phase B).
  const [brokerAttemptCache, setBrokerAttemptCache] = useState<BrokerRouteAttempt | null>(null);
  const [knowledgeHitCache, setKnowledgeHitCache] = useState<KnowledgeHit | null>(null);
  const [selectedKnowledgeQuery, setSelectedKnowledgeQuery] = useState("");
  const [contextCaptureRequest, setContextCaptureRequest] = useState<ContextCaptureRequest | null>(null);

  const settingsOpen = route.view === "settings";

  const selectedBrokerAttempt = useMemo(() => {
    if (route.view !== "broker" || !route.attemptId) return null;
    if (brokerAttemptCache?.id === route.attemptId) return brokerAttemptCache;
    // A deep link has only an id until the diagnostics feed hydrates it.
    // Do not cast that partial route state to a full attempt: inspector code
    // formats timestamps and other required fields immediately.
    return null;
  }, [brokerAttemptCache, route]);

  const selectedKnowledgeHit = useMemo(() => {
    if (route.view !== "search" || !route.hitId) return null;
    if (knowledgeHitCache?.id === route.hitId) return knowledgeHitCache;
    return null;
  }, [knowledgeHitCache, route]);

  // Session selection is routed sessionId only — no parallel memory fallback.
  const focusedSession = useMemo<FocusedSession | null>(() => {
    if (route.view === "agents-v2" && route.agentId && route.sessionId) {
      return { agentId: route.agentId, sessionId: route.sessionId };
    }
    if (route.view === "sessions" && route.sessionId) {
      return {
        agentId: route.agentId ?? "",
        sessionId: route.sessionId,
      };
    }
    return null;
  }, [route]);

  const focusSession = useCallback((agentId: string, sessionId: string) => {
    if (route.view === "agents-v2" && route.agentId === agentId) {
      navigate({ ...route, sessionId }, { replace: true });
      return;
    }
    if (route.view === "sessions") {
      navigate({ view: "sessions", sessionId, agentId }, { replace: true });
      return;
    }
    navigate({ view: "agents-v2", agentId, sessionId }, { replace: true });
  }, [navigate, route]);

  const openSettings = useCallback(() => {
    navigate({ view: "settings", section: "appearance" });
  }, [navigate]);
  const closeSettings = useCallback(() => {
    if (route.view !== "settings") return;
    navigate({ view: "inbox" });
  }, [navigate, route.view]);
  const openContextCapture = useCallback((request?: ContextCaptureRequest) => {
    setContextCaptureRequest(request ?? { intent: "new-task" });
  }, []);
  const closeContextCapture = useCallback(() => setContextCaptureRequest(null), []);
  const inspectBrokerAttempt = useCallback((attempt: BrokerRouteAttempt) => {
    setBrokerAttemptCache(attempt);
    if (route.view === "broker" && route.attemptId === attempt.id) return;
    navigate(
      {
        view: "broker",
        attemptId: attempt.id,
        ...(route.view === "broker" && route.filter ? { filter: route.filter } : {}),
      },
      { replace: route.view === "broker" },
    );
  }, [navigate, route]);
  const clearBrokerAttempt = useCallback(() => {
    setBrokerAttemptCache(null);
    if (route.view === "broker" && route.attemptId) {
      navigate(
        { view: "broker", ...(route.filter ? { filter: route.filter } : {}) },
        { replace: true },
      );
    }
  }, [navigate, route]);
  const inspectKnowledgeHit = useCallback((hit: KnowledgeHit, query?: string, filters?: SearchFilters) => {
    setKnowledgeHitCache(hit);
    if (typeof query === "string") {
      setSelectedKnowledgeQuery(query.trim());
    }
    if (route.view === "search" && route.hitId === hit.id) return;
    const carriedFilters = filters ?? (route.view === "search" ? route.filters : undefined);
    navigate(
      {
        view: "search",
        ...(route.view === "search" && route.mode ? { mode: route.mode } : {}),
        ...(carriedFilters ? { filters: carriedFilters } : {}),
        hitId: hit.id,
      },
      { replace: route.view === "search" },
    );
  }, [navigate, route]);
  const clearKnowledgeHit = useCallback(() => {
    setKnowledgeHitCache(null);
    setSelectedKnowledgeQuery("");
    if (route.view === "search" && route.hitId) {
      navigate({
        view: "search",
        ...(route.mode ? { mode: route.mode } : {}),
        ...(route.filters ? { filters: route.filters } : {}),
      }, { replace: true });
    }
  }, [navigate, route]);
  // Base web light/dark vars, with the native app's resolved palette layered on
  // top when hosted in the macOS embed (so the viewer matches the app exactly).
  const nativeThemeVars = useMemo(() => resolveScoutNativeThemeVars(), []);
  const resolvedTheme = hudsonTheme?.resolvedTheme ?? initialTheme;
  const activeTemplate = hudsonTheme?.template ?? "hudson";
  const themeVars = useMemo(
    () => ({
      ...scoutThemeAugmentVars(resolvedTheme),
      ...(nativeThemeVars ?? {}),
    }),
    [nativeThemeVars, resolvedTheme],
  );

  const updateAppearanceDetails = useCallback((patch: Partial<ScoutAppearanceDetails>) => {
    setAppearanceDetails((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    if (!agentsLoaded || agents.length === 0) return;
    setAppearanceDetails((current) => {
      const agentCharacters = migrateLegacyAgentCharacters(current.agentCharacters, agents);
      return agentCharacters === current.agentCharacters
        ? current
        : { ...current, agentCharacters };
    });
  }, [agents, agentsLoaded]);

  useEffect(() => {
    applyScoutThemeToDocument(resolvedTheme, activeTemplate, appearanceDetails);
    writeScoutAppearanceDetails(appearanceDetails);
  }, [activeTemplate, appearanceDetails, resolvedTheme]);

  useEffect(() => {
    const syncAppearance = (event: StorageEvent) => {
      if (event.key !== null && event.key !== SCOUT_THEME_STORAGE_KEY) return;
      setAppearanceDetails(resolveScoutStartupAppearanceDetails());
    };
    window.addEventListener("storage", syncAppearance);
    return () => window.removeEventListener("storage", syncAppearance);
  }, []);
  const scoutbotAgent = useMemo(() => resolveScoutbotAgent(agents), [agents]);
  const scoutbotAgentId = scoutbotAgent?.id ?? resolveScoutbotAgentId(agents);
  const scoutbotDmConversationId = scoutbotAgent?.conversationId ?? null;
  const reloadInFlightRef = useRef<{ url: string; promise: Promise<void> } | null>(null);
  const reloadEventTimerRef = useRef<number | null>(null);
  const agentInventoryUrl = route.view === "ops"
    ? "/api/agents"
    : "/api/agents?detail=summary";

  const markApiOnline = useCallback(() => {
    setApiConnection({
      status: "online",
      message: null,
      lastCheckedAt: Date.now(),
    });
  }, []);

  const markApiFailure = useCallback((cause: unknown) => {
    const message = friendlyApiError(cause);
    setApiConnection({
      status: isOfflineApiError(message) ? "offline" : "degraded",
      message,
      lastCheckedAt: Date.now(),
    });
  }, []);

  const reload = useCallback(async () => {
    const existing = reloadInFlightRef.current;
    if (existing) {
      await existing.promise;
      if (existing.url === agentInventoryUrl) return;
    }

    const request = (async () => {
      try {
        const agentsResult = await api<Agent[]>(agentInventoryUrl);
        setAgents((previous) => keepPreviousIfJsonEqual(previous, agentsResult));
        markApiOnline();
      } catch (cause) {
        markApiFailure(cause);
      } finally {
        setAgentsLoaded(true);
      }
    })();

    reloadInFlightRef.current = { url: agentInventoryUrl, promise: request };
    try {
      await request;
    } finally {
      if (reloadInFlightRef.current?.promise === request) {
        reloadInFlightRef.current = null;
      }
    }
  }, [agentInventoryUrl, markApiFailure, markApiOnline]);

  const refreshOnboarding = useCallback(async () => {
    try {
      const state = await api<OnboardingState>("/api/onboarding/state");
      onboardingStaleRef.current = false;
      setOnboarding(state);
      const resolved = state.operatorName?.trim() || state.operatorNameSuggestion?.trim() || null;
      setOperatorName(resolved);
      writeCachedOperatorName(resolved);
      markApiOnline();
    } catch (cause) {
      markApiFailure(cause);
      // Placeholder while the API is unreachable. `needed: false` is load-
      // bearing: without it the takeover treats the synthesized state as an
      // armed first-run and parks every tab that loads during a broker
      // restart on "Finish setup". The stale flag re-fetches the real state
      // from the poll loop once the API answers again.
      onboardingStaleRef.current = true;
      setOnboarding({
        hasLocalConfig: true,
        hasProjectConfig: true,
        hasOperatorName: true,
        localConfigPath: null,
        projectRoot: null,
        currentDirectory: null,
        operatorName: null,
        operatorNameSuggestion: null,
        needed: false,
      });
    }
  }, [markApiFailure, markApiOnline]);

  const skipOnboarding = useCallback(() => {
    setOnboardingSkipped(true);
    void api("/api/onboarding/skip", { method: "POST", body: "{}" })
      .then(() => refreshOnboarding())
      .catch(() => null);
  }, [refreshOnboarding]);

  useEffect(() => {
    void reload();
    void refreshOnboarding();
  }, [reload, refreshOnboarding]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (!isScoutSurfaceActive()) return;
      void reload();
      if (onboardingStaleRef.current) void refreshOnboarding();
    };

    const interval = window.setInterval(refreshIfVisible, AGENT_REFRESH_POLL_MS);
    const stopActivationListener = onScoutSurfaceActivated(refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      stopActivationListener();
    };
  }, [reload, refreshOnboarding]);

  const onlineCount = useMemo(
    () => agents.filter((a) => isAgentOnline(a.state)).length,
    [agents],
  );

  const [filePreviewPath, setFilePreviewPath] = useState<string | null>(null);
  const openFilePreview = useCallback((path: string) => {
    if (!path?.trim()) return;
    setFilePreviewPath(path.trim());
  }, []);
  const closeFilePreview = useCallback(() => setFilePreviewPath(null), []);

  const applyScoutbotUiAction = useCallback((action: ScoutbotUiAction) => {
    if (forwardScoutbotUiActionToNativeHost(action)) return;
    switch (action.type) {
      case "navigate":
        navigate(action.route);
        break;
      case "focus-composer":
        window.dispatchEvent(new CustomEvent("scout:composer-focus"));
        break;
      case "open-scoutbot":
        window.dispatchEvent(new CustomEvent("scout:scoutbot-panel-open", { detail: action }));
        break;
      case "refresh":
        void reload();
        break;
      case "view-file":
        openFilePreview(action.path);
        break;
    }
  }, [navigate, openFilePreview, reload]);

  const openFileInCode = useCallback((path: string, rootPath: string) => {
    const file = path.trim();
    const root = rootPath.trim();
    if (!file || !root) return;
    const returnConversationId = route.view === "conversation"
      ? route.conversationId
      : route.view === "messages"
        ? route.conversationId
        : window.location.pathname === "/embed/thread"
          ? new URLSearchParams(window.location.search).get("conversationId")?.trim() || undefined
          : undefined;
    closeFilePreview();
    applyScoutbotUiAction({
      type: "navigate",
      route: {
        view: "code",
        root,
        file,
        ...(returnConversationId ? { returnConversationId } : {}),
      },
    });
  }, [applyScoutbotUiAction, closeFilePreview, route]);

  const scoutbotBridgeRef = useRef({
    applyScoutbotUiAction,
  });
  scoutbotBridgeRef.current = { applyScoutbotUiAction };

  useBrokerEvents((event) => {
    if (!isScoutSurfaceActive()) return;
    if (AGENT_REFRESH_EVENT_KIND_SET.has(event.kind)) {
      if (reloadEventTimerRef.current !== null) {
        window.clearTimeout(reloadEventTimerRef.current);
      }
      reloadEventTimerRef.current = window.setTimeout(() => {
        reloadEventTimerRef.current = null;
        void reload();
      }, AGENT_REFRESH_EVENT_DEBOUNCE_MS);
    }
  });

  useEffect(() => () => {
    if (reloadEventTimerRef.current !== null) {
      window.clearTimeout(reloadEventTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const action = detail && typeof detail === "object" && "type" in detail
        ? detail as ScoutbotUiAction
        : null;
      if (action) {
        scoutbotBridgeRef.current.applyScoutbotUiAction(action);
      }
    };
    window.addEventListener("scout:scoutbot-ui-action", handler);
    window.scoutScoutbot = {
      applyUiAction: (action: ScoutbotUiAction) => scoutbotBridgeRef.current.applyScoutbotUiAction(action),
      navigate: (route: Route) => scoutbotBridgeRef.current.applyScoutbotUiAction({ type: "navigate", route }),
    };
    return () => {
      window.removeEventListener("scout:scoutbot-ui-action", handler);
      if (window.scoutScoutbot?.applyUiAction) {
        delete window.scoutScoutbot;
      }
    };
  }, []);

  const value = useMemo<ScoutContextValue>(
    () => ({
      route, navigate, navigateBack, canNavigateBack,
      agents, agentsLoaded, onlineCount, apiConnection, reload,
      appearanceDetails, updateAppearanceDetails,
      onboarding, operatorName, refreshOnboarding, onboardingSkipped, skipOnboarding,
      settingsOpen, openSettings, closeSettings,
      scoutbotAgentId, scoutbotConversationId: scoutbotDmConversationId, applyScoutbotUiAction,
      selectedBrokerAttempt, inspectBrokerAttempt, clearBrokerAttempt,
      selectedKnowledgeHit, selectedKnowledgeQuery, inspectKnowledgeHit, clearKnowledgeHit,
      focusedSession, focusSession,
      openFilePreview, closeFilePreview,
      openContextCapture, closeContextCapture,
    }),
    [
      route, navigate, navigateBack, canNavigateBack,
      agents, agentsLoaded, onlineCount, apiConnection, reload,
      appearanceDetails, updateAppearanceDetails,
      onboarding, operatorName, refreshOnboarding, onboardingSkipped, skipOnboarding,
      settingsOpen, openSettings, closeSettings,
      scoutbotAgentId, scoutbotDmConversationId, applyScoutbotUiAction,
      selectedBrokerAttempt, inspectBrokerAttempt, clearBrokerAttempt,
      selectedKnowledgeHit, selectedKnowledgeQuery, inspectKnowledgeHit, clearKnowledgeHit,
      focusedSession, focusSession,
      openFilePreview, closeFilePreview,
      openContextCapture, closeContextCapture,
    ],
  );

  return (
    <ScoutContext.Provider value={value}>
      {/* Two nested scopes, and the nesting is load-bearing. The outer element
        * hosts Hudson's and Scout's *raw* palette input (`--accent: 0.86 0.17
        * 125`), which HudsonKit resolves into `--hud-*` colors. The inner
        * element hosts Scout's legacy aliases (`--accent: var(--hud-accent)`).
        * They cannot share an element: HudsonKit declares the raw triplets at
        * [data-hudson-template][data-hudson-theme] (0,2,0) and appearance.css
        * at [data-scout-theme-mode][data-scout-palette] (0,2,0), both of which
        * outrank [data-scout-theme] (0,1,0) — so `--accent`/`--border`/
        * `--muted` would compute to bare triplets and every `var(--accent)` in
        * Scout's own CSS would be invalid (SVG strokes fall back to black,
        * hairlines to currentColor). Raising the alias specificity is not an
        * option either: on one element the two contracts form a var() cycle. */}
      <div
        data-scout-theme-mode={resolvedTheme}
        data-scout-palette={appearanceDetails.palette}
        data-scout-contrast={appearanceDetails.contrast}
        data-scout-accent={appearanceDetails.accent}
        data-scout-shell={appearanceDetails.shell}
        data-scout-avatar-style={appearanceDetails.avatarStyle}
        data-hudson-theme={resolvedTheme}
        data-hudson-template={activeTemplate}
        style={{
          ...themeVars,
        }}
      >
        {/* display:contents so the alias scope adds no box to the layout. */}
        <div data-scout-theme={resolvedTheme} style={{ display: "contents" }}>
          <ContextMenuProvider>
            <ScoutbotStateProvider>
              {realtimeVoiceEnabled
                ? <ScoutbotRealtimeVoiceProvider>{children}</ScoutbotRealtimeVoiceProvider>
                : children}
              <FilePreviewOverlay
                path={filePreviewPath}
                onOpenPath={openFilePreview}
                onOpenInCode={openFileInCode}
                onClose={closeFilePreview}
              />
              <ContextCaptureHost
                request={contextCaptureRequest}
                onClose={closeContextCapture}
                onOpenCapture={openContextCapture}
              />
            </ScoutbotStateProvider>
          </ContextMenuProvider>
        </div>
      </div>
    </ScoutContext.Provider>
  );
}
