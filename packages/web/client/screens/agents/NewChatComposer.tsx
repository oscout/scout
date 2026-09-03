import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronDown, FileText, Loader2, Search, X } from "lucide-react";
import {
  MessageComposer,
  MessageComposerSuggestions,
  RuntimePicker,
  runtimeCatalogFromRunnerOptions,
  type MessageComposerChangeMeta,
  type RuntimeValue,
} from "../../components/MessageComposer/index.ts";
import { compactAgentId } from "../../lib/agent-labels.ts";
import { api, peekApiGet } from "../../lib/api.ts";
import { actorColor } from "../../lib/colors.ts";
import {
  clampComposerFrame,
  composerFrameEnabled,
  composerInputMinHeight,
  moveComposerFrame,
  readStoredComposerFrame,
  resolveComposerFrameForViewport,
  resizeComposerFrame,
  writeStoredComposerFrame,
  type ComposerFrame,
  type ComposerResizeEdge,
} from "../../lib/composer-frame.ts";
import { RUNTIME_CAPABILITY_SEED } from "../../lib/runtime-capabilities.ts";
import {
  createClientMessageId,
  stageAcceptedConversationTurn,
} from "../../lib/client-turn-transition.ts";
import type {
  ContextCaptureDraft,
  ContextCaptureIntent,
  ForwardContextMode,
  ForwardContextSource,
} from "../../lib/context-capture-draft.ts";
import {
  boundedSelection,
  buildComposerContext,
  formatComposerContextBody,
} from "../../lib/composer-context.ts";
import { buildForwardTaskInstructions } from "../../lib/forward-context.ts";
import { NewChatOrigin } from "./NewChatOrigin.tsx";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import {
  dataTransferMayContainFiles,
  isRoutableMediaFile,
  readTransferredFiles,
  uploadMediaFiles,
  type OutgoingAttachment,
} from "../../lib/media-blobs.ts";
import { resolveCaptureRouteContext } from "../../lib/media-route.ts";
import { readRecentProjectRoots, rememberProjectRoot } from "../../lib/project-recency.ts";
import {
  buildProjectLaunchTargets,
  chooseInitialProjectLaunchTarget,
  orderProjectLaunchTargetsByRecency,
  routeCaptureToAgent,
  searchProjectLaunchTargets,
  startProjectSession,
  type CaptureDeliveryMode,
  type ProjectLaunchTarget,
} from "../../lib/session-start.ts";
import type { Agent, AgentConfigurationState, Route } from "../../lib/types.ts";
import {
  SLASH_COMMANDS,
  matchMentionTrigger,
  matchSlashTrigger,
  type MentionCandidate,
  type MentionSuggestState,
  type SlashCommand,
  type SlashSuggestState,
} from "../chat/conversation-model.ts";
import "./agents-rail.css";

type Navigate = (route: Route) => void;
type SubmitPhase = "idle" | "uploading" | "starting";

type RunnerHarnessOption = {
  id: string;
  label: string;
  description: string | null;
  state: string | null;
  ready: boolean | null;
  detail: string | null;
};

type RunnerModelOption = {
  id: string;
  label: string;
  description?: string | null;
  harnesses: string[];
  source: string;
};

type RunnerEffortOption = {
  id: string;
  label: string;
  description?: string | null;
  harnesses: string[];
  models?: string[];
};

type RunnerOptionsState = {
  defaults: {
    harness: string;
    model: string | null;
    reasoningEffort: string | null;
  };
  defaultsByHarness?: Partial<Record<string, {
    model?: string | null;
    reasoningEffort?: string | null;
  }>>;
  harnesses: RunnerHarnessOption[];
  models: RunnerModelOption[];
  efforts: RunnerEffortOption[];
};

const FALLBACK_HARNESSES: RunnerHarnessOption[] = RUNTIME_CAPABILITY_SEED.harnesses.map((entry) => ({
  id: entry.id,
  label: entry.label ?? entry.id,
  description: null,
  state: null,
  ready: null,
  detail: null,
}));

const FALLBACK_MODELS: RunnerModelOption[] = RUNTIME_CAPABILITY_SEED.models.map((entry) => ({
  id: entry.id,
  label: entry.label ?? entry.id,
  description: entry.description ?? null,
  harnesses: [...entry.harnesses],
  source: "catalog",
}));

const FALLBACK_EFFORTS: RunnerEffortOption[] = RUNTIME_CAPABILITY_SEED.efforts.map((entry) => ({
  ...entry,
  harnesses: [...entry.harnesses],
  ...(entry.models ? { models: [...entry.models] } : {}),
}));

/** Cold-start catalog: the bundled runtime catalog is immediately usable. */
const FALLBACK_RUNNER_OPTIONS: RunnerOptionsState = {
  defaults: {
    harness: RUNTIME_CAPABILITY_SEED.defaults?.harness ?? "claude",
    model: RUNTIME_CAPABILITY_SEED.defaults?.model ?? null,
    reasoningEffort: RUNTIME_CAPABILITY_SEED.defaults?.reasoningEffort ?? "medium",
  },
  defaultsByHarness: RUNTIME_CAPABILITY_SEED.defaultsByHarness,
  harnesses: FALLBACK_HARNESSES,
  models: FALLBACK_MODELS,
  efforts: FALLBACK_EFFORTS,
};

/**
 * The catalog only changes when the installed harness fleet does, so the last
 * good snapshot survives the dialog: reopening New task renders it instantly
 * and revalidates in the background, instead of showing "Loading the model
 * catalog…" on every open. Kept at module scope because the dialog unmounts
 * on close.
 */
let cachedRunnerOptions: RunnerOptionsState | null = null;
const RUNNER_OPTIONS_PATH = "/api/runner/options";
const RUNNER_OPTIONS_CACHE_MAX_AGE_MS = 5 * 60_000;

/** Rows the standing project list keeps on screen; the rest live behind the foot. */
const PROJECT_STANDING_ROWS = 5;

function firstModelForHarness(options: RunnerOptionsState, harness: string): string {
  const configuredDefault = options.defaults.harness === harness
    ? options.defaults.model?.trim() ?? ""
    : "";
  if (configuredDefault && options.models.some((candidate) => (
    candidate.id === configuredDefault && candidate.harnesses.includes(harness)
  ))) {
    return configuredDefault;
  }
  return options.models.find((candidate) => candidate.harnesses.includes(harness))?.id ?? "";
}

function firstEffortForHarness(options: RunnerOptionsState, harness: string): string {
  const supported = options.efforts.filter((candidate) => candidate.harnesses.includes(harness));
  return supported.find((candidate) => candidate.id === options.defaults.reasoningEffort)?.id
    ?? supported.find((candidate) => candidate.id === "medium")?.id
    ?? supported[0]?.id
    ?? "";
}

function previewUrl(file: File): string {
  return URL.createObjectURL(file);
}

function shortProjectPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/u, "~");
}

function projectTitleFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function isDirectProjectPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("~/");
}

function AttachmentPreview({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const url = useMemo(() => previewUrl(file), [file]);
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const isVideo = file.type.startsWith("video/");
  const isImage = file.type.startsWith("image/");
  return (
    <div className="s-newchat-attachment">
      {isVideo ? (
        <video src={url} muted playsInline />
      ) : isImage ? (
        <img src={url} alt={file.name} />
      ) : (
        <div className="s-newchat-attachment-file" title={file.name}>
          <FileText size={24} aria-hidden="true" />
          <span>{file.name}</span>
        </div>
      )}
      <span className="s-newchat-attachment-badge">
        {isVideo ? "video" : isImage ? "image" : "file"}
      </span>
      <button
        type="button"
        className="s-newchat-attachment-remove"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Route a capture or start a fresh conversation. Pick the agent, choose
 * existing chat vs new session when available, attach screenshots/videos, and
 * land in the message tab with the broker delivery already sent.
 */
function currentViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function NewChatComposer({
  agents,
  route,
  navigate,
  onClose,
  initialAgentId,
  initialConversationId,
  initialMessage,
  initialFiles,
  initialAttachmentFeedback,
  initialIntent = "new-task",
  initialProjectPath,
  initialForwardContext,
  initialForwardContextMode = "selected-message",
  defaultMode,
  draftRestored = false,
  onDraftChange,
  onDraftConsumed,
}: {
  agents: Agent[];
  navigate: Navigate;
  onClose: () => void;
  route: Route;
  initialAgentId?: string;
  initialConversationId?: string;
  initialMessage?: string;
  initialFiles?: File[];
  initialAttachmentFeedback?: string;
  initialIntent?: ContextCaptureIntent;
  initialProjectPath?: string;
  initialProjectQuery?: string;
  initialForwardContext?: ForwardContextSource;
  initialForwardContextMode?: ForwardContextMode;
  defaultMode?: CaptureDeliveryMode;
  draftRestored?: boolean;
  onDraftChange?: (draft: ContextCaptureDraft) => void;
  onDraftConsumed?: () => void;
}) {
  const routeContext = useMemo(() => resolveCaptureRouteContext(route, agents), [route, agents]);
  const isForwarding = initialIntent === "forward-message" && Boolean(initialForwardContext);
  const sorted = useMemo(
    () => [...agents].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [agents],
  );
  // A fresh task is project-routed. Ambient page/session context must never
  // become an invisible continuation target; contextual routing is reserved
  // for the explicit file-capture flow.
  const routeAgentId = initialIntent === "route-capture"
    ? initialAgentId ?? routeContext.agentId ?? null
    : null;
  const routeConversationId = initialIntent === "route-capture"
    ? initialConversationId ?? routeContext.conversationId
    : null;
  const routeAgent = sorted.find((candidate) => candidate.id === routeAgentId) ?? null;
  const preferredProjectRoot = routeAgent?.projectRoot ?? routeAgent?.cwd ?? null;
  const [configuration, setConfiguration] = useState<AgentConfigurationState | null>(null);
  const [runnerOptions, setRunnerOptions] = useState<RunnerOptionsState | null>(() => (
    cachedRunnerOptions
    ?? peekApiGet<RunnerOptionsState>(RUNNER_OPTIONS_PATH, RUNNER_OPTIONS_CACHE_MAX_AGE_MS)
  ));
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [runnerLoadError, setRunnerLoadError] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState(() => initialProjectPath || preferredProjectRoot || "");
  // A filter, not the selected value — empty means "show the standing list".
  // Deliberately NOT seeded from the draft: the draft preserves the selection
  // (`projectPath`), and restoring filter text would narrow the standing list to
  // whatever was last typed. Worse, the draft is rewritten on mount, so a stale
  // title would keep re-persisting itself and never clear.
  const [projectQuery, setProjectQuery] = useState("");
  const [activeProjectIndex, setActiveProjectIndex] = useState(0);
  // Device-local "where I last chose to work", newest first. Read once per
  // mount and updated in place on a pick, so the standing list and the initial
  // selection agree without re-reading storage on every render.
  const [recentProjectRoots, setRecentProjectRoots] = useState<string[]>(
    () => readRecentProjectRoots(),
  );
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectReminder, setProjectReminder] = useState<string | null>(null);
  const [message, setMessage] = useState(() => initialMessage ?? "");
  const [forwardContextMode, setForwardContextMode] = useState<ForwardContextMode>(
    initialForwardContextMode,
  );
  const [slashState, setSlashState] = useState<SlashSuggestState>({
    open: false,
    query: "",
    triggerStart: -1,
    index: 0,
  });
  const [mentionState, setMentionState] = useState<MentionSuggestState>({
    open: false,
    query: "",
    triggerStart: -1,
    index: 0,
  });
  const [files, setFiles] = useState<File[]>(() => [...(initialFiles ?? [])]);
  const [mode, setMode] = useState<CaptureDeliveryMode>(() => {
    if (defaultMode) return defaultMode;
    if (routeConversationId) return "existing-chat";
    return "new-session";
  });
  const [state, setState] = useState<"idle" | "starting">("idle");
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [attachmentFeedback, setAttachmentFeedback] = useState<string | null>(
    () => initialAttachmentFeedback ?? null,
  );
  // Where the operator was when they opened this. Read once on mount: opening
  // the panel moves focus and clears the document selection, so by the time
  // there is a button to press the selection is already gone. Capturing the
  // snapshot is not the same as sending it — nothing below reaches the message
  // until `attachSelection` is true.
  const [origin] = useState(() => {
    if (typeof window === "undefined") return { title: "", url: "", selection: "" };
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    return {
      title: document.title,
      url: window.location.href,
      selection: typing ? "" : boundedSelection(window.getSelection()?.toString() ?? ""),
    };
  });
  const [attachSelection, setAttachSelection] = useState(false);
  const [harness, setHarness] = useState(() => (
    routeAgent?.harness?.trim() || FALLBACK_RUNNER_OPTIONS.defaults.harness
  ));
  const [model, setModel] = useState(() => (
    routeAgent?.model?.trim() || FALLBACK_RUNNER_OPTIONS.defaults.model || ""
  ));
  const [reasoningEffort, setReasoningEffort] = useState(
    FALLBACK_RUNNER_OPTIONS.defaults.reasoningEffort || "",
  );
  const [preservationNotice, setPreservationNotice] = useState<string | null>(
    () => draftRestored ? "Restored your unsent draft." : null,
  );
  const [dragDepth, setDragDepth] = useState(0);
  const { ref, onKeyDown } = useFocusTrap<HTMLDivElement>(true);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const projectSelectionTouchedRef = useRef(Boolean(initialProjectPath));
  const runtimeSelectionTouchedRef = useRef(false);

  // ── Panel placement ────────────────────────────────────────────────────────
  // Null is the standing centered panel. It only becomes a frame once the
  // operator drags the header or a resize edge, and that frame then persists
  // per browser profile so the next capture opens where they left it.
  const [frame, setFrame] = useState<ComposerFrame | null>(null);
  const [gesture, setGesture] = useState<"move" | "resize" | null>(null);
  const gestureRef = useRef<
    { base: ComposerFrame; x: number; y: number; edge: ComposerResizeEdge | null } | null
  >(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setFrame(resolveComposerFrameForViewport(
      null,
      readStoredComposerFrame(),
      currentViewport(),
    ));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onViewportResize = () => {
      setFrame((current) => {
        const viewport = currentViewport();
        return resolveComposerFrameForViewport(
          current,
          current ? null : readStoredComposerFrame(),
          viewport,
        );
      });
    };
    window.addEventListener("resize", onViewportResize);
    return () => window.removeEventListener("resize", onViewportResize);
  }, []);

  const measuredFrame = useCallback((): ComposerFrame | null => {
    if (frame) return frame;
    const node = ref.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, [frame, ref]);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    edge: ComposerResizeEdge | null,
  ) => {
    if (typeof window === "undefined") return;
    if (event.button !== 0) return;
    if (!composerFrameEnabled(window.innerWidth)) return;
    // The header carries the close button; a press on a control is not a drag.
    if (!edge && (event.target as HTMLElement | null)?.closest("button")) return;
    const base = measuredFrame();
    if (!base) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { base, x: event.clientX, y: event.clientY, edge };
    setGesture(edge ? "resize" : "move");
    setFrame(clampComposerFrame(base, currentViewport()));
  };

  const continueGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const active = gestureRef.current;
    if (!active) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const viewport = currentViewport();
    setFrame(active.edge
      ? resizeComposerFrame(active.base, dx, dy, active.edge, viewport)
      : moveComposerFrame(active.base, dx, dy, viewport));
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (!gestureRef.current) return;
    gestureRef.current = null;
    setGesture(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The capture is already gone on cancel; nothing to release.
    }
    setFrame((current) => {
      if (current) writeStoredComposerFrame(current);
      return current;
    });
  };

  const resetFrame = () => {
    gestureRef.current = null;
    setGesture(null);
    setFrame(null);
    writeStoredComposerFrame(null);
  };

  const gestureHandlers = (edge: ComposerResizeEdge | null) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginGesture(event, edge),
    onPointerMove: continueGesture,
    onPointerUp: endGesture,
    onPointerCancel: endGesture,
  });

  const inputMinHeight = composerInputMinHeight(frame);
  const panelStyle: CSSProperties | undefined = frame
    ? {
        position: "absolute",
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        maxWidth: "none",
        maxHeight: "none",
        ...(inputMinHeight ? { "--s-newchat-input-min": `${inputMinHeight}px` } : {}),
      } as CSSProperties
    : undefined;

  const projectTargets = useMemo(
    () => orderProjectLaunchTargetsByRecency(
      buildProjectLaunchTargets(
        configuration?.projects ?? [],
        agents,
        configuration?.context.defaultHarness ?? "claude",
      ),
      recentProjectRoots,
    ),
    [agents, configuration, recentProjectRoots],
  );
  const knownSelectedProject = projectTargets.find((candidate) => candidate.root === projectPath) ?? null;
  const selectedProject: ProjectLaunchTarget | null = knownSelectedProject ?? (projectPath
    ? {
        id: `direct:${projectPath}`,
        title: projectTitleFromPath(projectPath),
        root: projectPath,
        defaultHarness: configuration?.context.defaultHarness ?? routeAgent?.harness ?? "claude",
        source: "agent",
        registrationKind: null,
      }
    : null);
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const seen = new Set<string>();
    const scopedAgents = selectedProject
      ? sorted.filter((agent) => (
          agent.projectRoot?.trim() === selectedProject.root
          || agent.cwd?.trim() === selectedProject.root
        ))
      : [];
    // Worktree sessions often report their worktree as cwd rather than the
    // canonical project root. Keep project-local results first when available,
    // but never turn @ into an empty affordance because those paths differ.
    const projectAgents = scopedAgents.length > 0 ? scopedAgents : sorted;

    return projectAgents.flatMap((agent) => {
      if (agent.retiredFromFleet) return [];
      const handle = agent.handle?.trim().replace(/^@+/, "")
        || compactAgentId(agent.id)
        || "";
      const key = handle.toLowerCase();
      if (!handle || seen.has(key)) return [];
      seen.add(key);
      return [{
        id: agent.id,
        label: handle,
        name: agent.name || handle,
        handle,
      }];
    });
  }, [selectedProject, sorted]);
  const harnesses = runnerOptions?.harnesses ?? FALLBACK_HARNESSES;
  const selectedHarness = harnesses.find((candidate) => candidate.id === harness) ?? null;
  // The picker runs on a nested catalog — harnesses with their models and
  // effort ladders folded in, unready harnesses listed but unselectable. A
  // harness the catalog doesn't know (route agent pinned to something
  // unlisted) is appended so it stays selectable instead of silently
  // resetting; an unknown model is the picker's own "custom" row.
  const runtimeCatalog = useMemo(() => {
    const catalog = runtimeCatalogFromRunnerOptions(runnerOptions ?? FALLBACK_RUNNER_OPTIONS);
    if (harness && !catalog.harnesses.some((entry) => entry.value === harness)) {
      return {
        ...catalog,
        harnesses: [
          ...catalog.harnesses,
          {
            value: harness,
            label: harness,
            models: [{ value: "", label: "Default", note: "harness picks" }],
          },
        ],
      };
    }
    return catalog;
  }, [runnerOptions, harness]);
  // Uncapped: only PROJECT_STANDING_ROWS are ever rendered, and the foot needs a
  // truthful match count to report what it is holding back.
  const filteredProjects = useMemo(
    () => searchProjectLaunchTargets(projectTargets, projectQuery),
    [projectQuery, projectTargets],
  );
  // The list stands in normal flow rather than opening over the panel, so typing
  // replaces these rows in place — nothing moves, nothing opens.
  const visibleProjects = useMemo(() => {
    const rows = filteredProjects.slice(0, PROJECT_STANDING_ROWS);
    if (!projectPath || rows.some((candidate) => candidate.root === projectPath)) return rows;
    // An active row you cannot see is worse than one fewer alternative.
    const selected = filteredProjects.find((candidate) => candidate.root === projectPath);
    return selected ? [selected, ...rows.slice(0, PROJECT_STANDING_ROWS - 1)] : rows;
  }, [filteredProjects, projectPath]);
  const directPathCandidate = isDirectProjectPath(projectQuery)
    && !projectTargets.some((candidate) => candidate.root === projectQuery.trim())
    ? projectQuery.trim()
    : null;
  const projectOptionCount = visibleProjects.length + (directPathCandidate ? 1 : 0);
  // Count the real inventory when unfiltered; the match set once the user types.
  const projectsHeldBack = Math.max(
    0,
    (projectQuery.trim() ? filteredProjects.length : projectTargets.length) - visibleProjects.length,
  );
  const projectMatchesRouteAgent = Boolean(
    routeAgent
    && selectedProject
    && [routeAgent.projectRoot, routeAgent.cwd].some((root) => root?.trim() === selectedProject.root),
  );
  const hasAttachments = files.length > 0;
  const isStarting = state === "starting";
  const isDraggingFiles = dragDepth > 0;
  const canUseExistingChat = projectMatchesRouteAgent
    && Boolean(routeAgent?.conversationId || routeConversationId);
  const usesNewWorker = !hasAttachments || !canUseExistingChat || mode === "new-session";
  // The bundled catalog is a complete launchable baseline. Live readiness is
  // enrichment, so a slow probe must not disable the picker or Start action.
  const runtimeBlocked = usesNewWorker && selectedHarness?.ready === false;
  const title = isForwarding ? "Forward to new task" : hasAttachments ? "Route capture" : "New task";
  // Forwarding states its source turns; a plain new task states its origin
  // route. Both describe where the work came from, so they never stack.
  const originContext = useMemo(
    () => (isForwarding ? [] : buildComposerContext({
      pageTitle: origin.title,
      pageUrl: origin.url,
      selection: attachSelection ? origin.selection : undefined,
    })),
    [attachSelection, isForwarding, origin],
  );
  const committedMessage = isForwarding && initialForwardContext
    ? buildForwardTaskInstructions(initialForwardContext, forwardContextMode, message)
    : formatComposerContextBody(message, originContext);
  const phaseLabel = phase === "uploading"
    ? "Uploading capture"
    : isForwarding
      ? "Forwarding to new task"
    : hasAttachments
      ? "Routing capture"
      : "Sending message";
  const progressDetail = hasAttachments
    ? `Submitted to ${selectedProject?.title ?? routeAgent?.name ?? "Scout"}. Opening the chat when the broker returns it.`
    : committedMessage
      ? `Routing your first message through /${selectedProject?.title ?? routeAgent?.name ?? "project"}.`
      : `Starting a project-routed chat in /${selectedProject?.title ?? routeAgent?.name ?? "project"}.`;
  const showDeliveryMode = hasAttachments && canUseExistingChat;
  const showRuntimeStatus = usesNewWorker
    && (Boolean(runnerLoadError) || selectedHarness?.ready === false);
  const showConfig = showDeliveryMode || (!isForwarding && showRuntimeStatus);
  const filteredSlashCommands = useMemo(() => {
    if (!slashState.open) return [];
    const query = slashState.query.toLowerCase();
    if (!query) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((command) => (
      command.command.toLowerCase().startsWith(`/${query}`)
      || command.command.toLowerCase().includes(query)
    ));
  }, [slashState.open, slashState.query]);
  const filteredMentions = useMemo(() => {
    if (!mentionState.open) return [];
    const query = mentionState.query.toLowerCase();
    if (!query) return mentionCandidates.slice(0, 8);
    return mentionCandidates.filter((candidate) => (
      candidate.handle.toLowerCase().includes(query)
      || candidate.name.toLowerCase().includes(query)
      || candidate.label.toLowerCase().includes(query)
    )).slice(0, 8);
  }, [mentionCandidates, mentionState.open, mentionState.query]);

  const closeSuggestions = useCallback(() => {
    setSlashState((current) => (current.open ? { ...current, open: false } : current));
    setMentionState((current) => (current.open ? { ...current, open: false } : current));
  }, []);

  const updateMessageTriggers = useCallback((value: string, caret: number) => {
    const slashMatch = matchSlashTrigger(value, caret);
    setSlashState((current) => slashMatch
      ? {
          open: true,
          query: slashMatch.query,
          triggerStart: slashMatch.start,
          index: current.open && current.triggerStart === slashMatch.start ? current.index : 0,
        }
      : current.open
        ? { ...current, open: false }
        : current);

    const mentionMatch = matchMentionTrigger(value, caret);
    setMentionState((current) => mentionMatch
      ? {
          open: true,
          query: mentionMatch.query,
          triggerStart: mentionMatch.start,
          index: current.open && current.triggerStart === mentionMatch.start ? current.index : 0,
        }
      : current.open
        ? { ...current, open: false }
        : current);
  }, []);

  const handleMessageChange = useCallback((next: string, meta?: MessageComposerChangeMeta) => {
    setMessage(next);
    updateMessageTriggers(next, meta?.caret ?? next.length);
  }, [updateMessageTriggers]);

  const applySlashCommand = useCallback((command: SlashCommand) => {
    const start = slashState.triggerStart;
    if (start < 0) return;
    const caret = textRef.current?.selectionStart ?? message.length;
    const before = message.slice(0, start);
    const after = message.slice(caret);
    const next = `${before}${command.insert}${after}`;
    setMessage(next);
    setSlashState((current) => ({ ...current, open: false }));
    requestAnimationFrame(() => {
      const field = textRef.current;
      if (!field) return;
      const position = before.length + command.insert.length;
      field.focus();
      field.setSelectionRange(position, position);
    });
  }, [message, slashState.triggerStart]);

  const applyMention = useCallback((candidate: MentionCandidate) => {
    const start = mentionState.triggerStart;
    if (start < 0) return;
    const caret = textRef.current?.selectionStart ?? message.length;
    const before = message.slice(0, start);
    const after = message.slice(caret);
    const insert = `@${candidate.handle}${after.length === 0 || !after.startsWith(" ") ? " " : ""}`;
    const next = `${before}${insert}${after}`;
    setMessage(next);
    setMentionState((current) => ({ ...current, open: false }));
    requestAnimationFrame(() => {
      const field = textRef.current;
      if (!field) return;
      const position = before.length + insert.length;
      field.focus();
      field.setSelectionRange(position, position);
    });
  }, [mentionState.triggerStart, message]);

  const insertComposerTrigger = useCallback((trigger: "/" | "@") => {
    if (isStarting) return;
    const field = textRef.current;
    const caret = field?.selectionStart ?? message.length;
    const before = message.slice(0, caret);
    const after = message.slice(caret);
    const spacer = before && !/\s$/.test(before) ? " " : "";
    const insertion = `${spacer}${trigger}`;
    const next = `${before}${insertion}${after}`;
    const position = before.length + insertion.length;
    setMessage(next);
    updateMessageTriggers(next, position);
    requestAnimationFrame(() => {
      const nextField = textRef.current;
      if (!nextField) return;
      nextField.focus();
      nextField.setSelectionRange(position, position);
    });
  }, [isStarting, message, updateMessageTriggers]);

  const handleMessageKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const slashOpen = slashState.open && filteredSlashCommands.length > 0;
    const mentionOpen = mentionState.open && filteredMentions.length > 0;
    if (!slashOpen && !mentionOpen) return false;

    if (event.key === "ArrowDown") {
      if (slashOpen) {
        setSlashState((current) => ({
          ...current,
          index: (current.index + 1) % filteredSlashCommands.length,
        }));
      } else {
        setMentionState((current) => ({
          ...current,
          index: (current.index + 1) % filteredMentions.length,
        }));
      }
      return true;
    }
    if (event.key === "ArrowUp") {
      if (slashOpen) {
        setSlashState((current) => ({
          ...current,
          index: (current.index - 1 + filteredSlashCommands.length) % filteredSlashCommands.length,
        }));
      } else {
        setMentionState((current) => ({
          ...current,
          index: (current.index - 1 + filteredMentions.length) % filteredMentions.length,
        }));
      }
      return true;
    }
    if (event.key === "Escape") {
      closeSuggestions();
      return true;
    }
    if (
      (event.key === "Enter" || event.key === "Tab")
      && !event.shiftKey
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
    ) {
      if (slashOpen) {
        const command = filteredSlashCommands[slashState.index] ?? filteredSlashCommands[0];
        if (command) applySlashCommand(command);
      } else {
        const mention = filteredMentions[mentionState.index] ?? filteredMentions[0];
        if (mention) applyMention(mention);
      }
      return true;
    }
    return false;
  }, [
    applyMention,
    applySlashCommand,
    closeSuggestions,
    filteredMentions,
    filteredSlashCommands,
    mentionState.index,
    mentionState.open,
    slashState.index,
    slashState.open,
  ]);

  const requestClose = useCallback(() => {
    if (isStarting) return;
    onClose();
  }, [isStarting, onClose]);

  const retainOnBackdropClick = useCallback(() => {
    setPreservationNotice("Draft kept open. Use Esc or × when you are ready to close it.");
    requestAnimationFrame(() => textRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  useEffect(() => {
    if (!preservationNotice) return;
    const timeout = window.setTimeout(() => setPreservationNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [preservationNotice]);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const loadConfiguration = useCallback(() => {
    let cancelled = false;
    void api<AgentConfigurationState>("/api/agent-config/snapshot")
      .then((snapshot) => {
        if (cancelled) return;
        setConfiguration(snapshot);
        setProjectLoadError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setProjectLoadError(caught instanceof Error ? caught.message : "Could not load projects.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The canonical project inventory is expensive on a large workstation.
  // Agent-derived and current-project rows already make the closed picker
  // useful, so only enrich the list when the operator asks to browse it.
  useEffect(() => {
    if (!projectPickerOpen || configuration) return;
    return loadConfiguration();
  }, [configuration, loadConfiguration, projectPickerOpen]);

  // Callable so the picker's error state can offer a real retry.
  const loadRunnerOptions = useCallback(() => {
    void api<RunnerOptionsState>(RUNNER_OPTIONS_PATH)
      .then((snapshot) => {
        cachedRunnerOptions = snapshot;
        setRunnerOptions(snapshot);
        setRunnerLoadError(null);
      })
      .catch(() => {
        // With a cached catalog already on screen a failed background
        // revalidation changes nothing the operator can act on — the error
        // state is reserved for having no catalog at all.
        if (!cachedRunnerOptions) {
          setRunnerLoadError("Live model availability is unavailable. Using the bundled catalog.");
        }
      });
  }, []);

  useEffect(() => {
    loadRunnerOptions();
  }, [loadRunnerOptions]);

  useEffect(() => {
    if (projectSelectionTouchedRef.current || projectTargets.length === 0) return;
    const initial = chooseInitialProjectLaunchTarget(projectTargets, {
      preferredRoot: preferredProjectRoot,
      currentDirectory: configuration?.context.currentDirectory,
      recentRoots: recentProjectRoots,
    });
    if (!initial) return;
    // Selection only. Typing the resolved project's title into the filter would
    // open the dialog with the standing list already narrowed to one row — the
    // choice was made for the operator, so it should be shown as the active row,
    // not as a search term they have to clear.
    setProjectPath(initial.root);
  }, [
    configuration?.context.currentDirectory,
    preferredProjectRoot,
    projectTargets,
    recentProjectRoots,
  ]);

  useEffect(() => {
    if (runtimeSelectionTouchedRef.current) return;
    const nextHarness = selectedProject?.defaultHarness?.trim()
      || routeAgent?.harness?.trim()
      || runnerOptions?.defaults.harness
      || "claude";
    setHarness(nextHarness);
    if (!runnerOptions) return;
    const routeModel = routeAgent?.model?.trim() ?? "";
    const routeModelSupported = runnerOptions.models.some((candidate) => (
      candidate.id === routeModel && candidate.harnesses.includes(nextHarness)
    ));
    setModel(routeModelSupported ? routeModel : firstModelForHarness(runnerOptions, nextHarness));
    setReasoningEffort(firstEffortForHarness(runnerOptions, nextHarness));
  }, [routeAgent?.harness, routeAgent?.model, runnerOptions, selectedProject?.defaultHarness, selectedProject?.root]);

  useLayoutEffect(() => {
    onDraftChange?.({
      intent: initialIntent,
      ...(routeAgentId ? { agentId: routeAgentId } : {}),
      ...(routeConversationId
        ? { conversationId: routeConversationId }
        : {}),
      message,
      files,
      attachmentFeedback,
      mode,
      projectPath,
      // The filter, not the selection. `projectPath` already carries which project
      // is chosen; storing the title here used to be how the field remembered its
      // value, and restoring it now would pre-filter the standing list down to the
      // single row the operator had already picked.
      projectQuery,
      ...(isForwarding && initialForwardContext ? { forwardContext: initialForwardContext } : {}),
      forwardContextMode,
    });
  }, [
    attachmentFeedback,
    files,
    forwardContextMode,
    initialForwardContext,
    initialIntent,
    isForwarding,
    message,
    mode,
    onDraftChange,
    projectPath,
    projectQuery,
    routeAgentId,
    routeConversationId,
    selectedProject?.title,
  ]);

  const addFiles = useCallback((incoming: File[], action = "Added") => {
    if (isStarting) return;
    const accepted = incoming.filter(isRoutableMediaFile);
    const rejected = incoming.filter((file) => !isRoutableMediaFile(file));

    if (accepted.length > 0) {
      setFiles((current) => [...current, ...accepted]);
      setAttachmentFeedback(
        accepted.length === 1
          ? `${action} ${accepted[0]?.name ?? "1 attachment"}.`
          : `${action} ${accepted.length} attachments.`,
      );
    }

    if (rejected.length > 0) {
      const rejectedLabel = rejected.length === 1
        ? rejected[0]?.name ?? "That file"
        : `${rejected.length} files`;
      setError(
        `${rejectedLabel} ${rejected.length === 1 ? "is" : "are"} not supported. Attach markdown, code, an image, or a video clip.`,
      );
    } else if (accepted.length > 0) {
      setError(null);
    }
  }, [isStarting]);

  const acceptTransfer = useCallback((dataTransfer: DataTransfer, action: string) => {
    const incoming = readTransferredFiles(dataTransfer);
    if (incoming.length === 0) {
      setError("Scout could not read that file. Try dropping or pasting it again.");
      return;
    }
    addFiles(incoming, action);
  }, [addFiles]);

  const handleDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (isStarting || !dataTransferMayContainFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDragDepth(dragDepthRef.current);
  }, [isStarting]);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (isStarting || !dataTransferMayContainFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, [isStarting]);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    setDragDepth(dragDepthRef.current);
  }, []);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!dataTransferMayContainFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragDepth(0);
    acceptTransfer(event.dataTransfer, "Added");
  }, [acceptTransfer]);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLElement>) => {
    if (isStarting || !dataTransferMayContainFiles(event.clipboardData)) return;
    event.preventDefault();
    event.stopPropagation();
    acceptTransfer(event.clipboardData, "Pasted");
  }, [acceptTransfer, isStarting]);

  // The input is a FILTER, not a value holder — the selection shows as the active
  // row plus the path line, so committing clears the filter and the standing list
  // returns to the full set with the new choice marked.
  const selectProject = (project: ProjectLaunchTarget) => {
    projectSelectionTouchedRef.current = true;
    // Only an explicit pick is recorded. Writing the composer's own default
    // back would make that default self-confirming and the list would stop
    // reflecting choices anyone actually made.
    setRecentProjectRoots(rememberProjectRoot(project.root));
    setProjectPath(project.root);
    setProjectQuery("");
    setActiveProjectIndex(0);
    setProjectPickerOpen(false);
    setProjectReminder(null);
    requestAnimationFrame(() => textRef.current?.focus());
  };

  const selectDirectPath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    projectSelectionTouchedRef.current = true;
    setRecentProjectRoots(rememberProjectRoot(trimmed));
    setProjectPath(trimmed);
    setProjectQuery("");
    setActiveProjectIndex(0);
    setProjectPickerOpen(false);
    setProjectReminder(null);
    requestAnimationFrame(() => textRef.current?.focus());
  };

  const clearProject = () => {
    projectSelectionTouchedRef.current = true;
    setProjectPath("");
    setProjectQuery("");
    setActiveProjectIndex(0);
    setProjectPickerOpen(false);
    setProjectReminder(null);
    requestAnimationFrame(() => textRef.current?.focus());
  };

  const handleProjectKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveProjectIndex((current) => {
        if (projectOptionCount === 0) return 0;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        return (current + delta + projectOptionCount) % projectOptionCount;
      });
      return;
    }
    // The listbox is always visible, so Enter always commits the active row.
    if (event.key === "Enter") {
      event.preventDefault();
      const project = visibleProjects[activeProjectIndex];
      if (project) selectProject(project);
      else if (directPathCandidate && activeProjectIndex === visibleProjects.length) {
        selectDirectPath(directPathCandidate);
      }
      return;
    }
    // Escape clears a filter in progress before it closes the dialog; with no
    // filter to clear it falls through to the panel's own Esc handler.
    if (event.key === "Escape" && projectPickerOpen && projectQuery) {
      event.preventDefault();
      event.stopPropagation();
      setProjectQuery("");
      setActiveProjectIndex(0);
    }
  };

  // Reconciliation (model reset on harness change, effort clamping) is the
  // picker's catalog logic — the picker hands back an already-repaired value.
  const handleRuntimeChange = (next: RuntimeValue) => {
    runtimeSelectionTouchedRef.current = true;
    setHarness(next.harness);
    setModel(next.model);
    setReasoningEffort(next.effort);
  };

  const start = async () => {
    if (isStarting) return;
    if (isForwarding && !committedMessage) {
      setError("Add instructions, or choose a context option that includes the source message.");
      requestAnimationFrame(() => textRef.current?.focus());
      return;
    }
    if (!selectedProject) {
      setError(null);
      setProjectReminder("Choose a project before starting this task.");
      setProjectPickerOpen(true);
      requestAnimationFrame(() => projectInputRef.current?.focus());
      return;
    }
    if (runtimeBlocked) return;
    setState("starting");
    setPhase(files.length > 0 ? "uploading" : "starting");
    setError(null);
    const clientMessageId = createClientMessageId();
    const submittedAt = Date.now();
    try {
      let attachments: OutgoingAttachment[] = [];
      if (files.length > 0) {
        attachments = await uploadMediaFiles(files);
        setPhase("starting");
      }

      if (hasAttachments && routeAgent && canUseExistingChat && mode === "existing-chat") {
        const resolvedMode = mode === "existing-chat" && canUseExistingChat
          ? "existing-chat"
          : "new-session";
        const result = await routeCaptureToAgent(routeAgent, {
          mode: resolvedMode,
          message: committedMessage,
          attachments,
        });
        // The composer can be shown again without a remount. A successful
        // route must not leave its prior task text in the next draft.
        setMessage("");
        setFiles([]);
        setAttachmentFeedback(null);
        navigate({
          view: "agents-v2",
          agentId: result.agentId,
          conversationId: result.conversationId,
          tab: "message",
        });
        onDraftConsumed?.();
        onClose();
        return;
      }

      const result = await startProjectSession({
        projectPath: selectedProject.root,
        harness,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(committedMessage
          ? { instructions: committedMessage }
          : hasAttachments
            ? { instructions: "Shared capture for context." }
            : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(isForwarding && initialForwardContext
          ? {
              fromMessageId: initialForwardContext.selectedMessageId,
              fromConversationId: initialForwardContext.sourceConversationId,
            }
          : {}),
        clientMessageId,
      });
      const conversationId = result.conversationId?.trim();
      if (!conversationId) {
        throw new Error("Message sent, but no Chat was returned.");
      }
      const messageId = result.messageId?.trim();
      if (messageId) {
        stageAcceptedConversationTurn({
          conversationId,
          messageId,
          clientMessageId,
          body: committedMessage || (attachments.length > 0 ? "Shared capture for context." : "New session started."),
          attachments,
          agentId: result.agentId,
          flightId: result.flightId,
          invocationId: result.invocationId,
          createdAt: submittedAt,
        });
      }
      // Keep the text on failures for retry, but clear it once the first
      // message has been accepted so the next new chat begins blank.
      setMessage("");
      navigate({
        view: "conversation",
        conversationId,
      });
      onDraftConsumed?.();
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : hasAttachments
            ? "Could not route capture."
            : "Could not send message.",
      );
      setState("idle");
      setPhase("idle");
    }
  };

  return (
    <div
      className="s-newchat-backdrop"
      onClick={retainOnBackdropClick}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
      role="presentation"
    >
      <div
        ref={ref}
        className={`s-newchat-panel${isStarting ? " s-newchat-panel--starting" : ""}${isDraggingFiles ? " s-newchat-panel--dragging" : ""}`}
        style={panelStyle}
        data-framed={frame ? "true" : undefined}
        data-gesture={gesture ?? undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <header
          className="s-newchat-head"
          title="Drag to move · double-click to recenter"
          onDoubleClick={resetFrame}
          {...gestureHandlers(null)}
        >
          <span className="s-newchat-title">{title}</span>
          <div className="s-newchat-head-status">
            <span role="status" aria-live="polite">{preservationNotice}</span>
          </div>
          <button
            type="button"
            className="s-newchat-close"
            onClick={requestClose}
            disabled={isStarting}
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        {isDraggingFiles ? (
          <div className="s-newchat-drop-prompt" role="status" aria-live="polite">
            Drop to attach markdown, code, images, or video
          </div>
        ) : null}

        <div className="s-newchat-body">
          <div className="s-newchat-lead">
            {isForwarding ? (
              <p className="s-newchat-forward-intro">
                Choose the destination, runtime, and visible Scout context to carry into a fresh task.
              </p>
            ) : null}

            <NewChatOrigin
              context={originContext}
              selection={origin.selection}
              attached={attachSelection}
              onToggleSelection={() => setAttachSelection((on) => !on)}
            />

            <div className="s-newchat-project-bar">
              <span className="label-md s-newchat-project-label">Project</span>
              <button
                type="button"
                className="s-newchat-project-summary"
                data-empty={selectedProject ? undefined : "true"}
                aria-expanded={projectPickerOpen}
                aria-controls="s-newchat-project-panel"
                aria-describedby={projectReminder ? "s-newchat-project-reminder" : undefined}
                disabled={isStarting}
                onClick={() => {
                  const nextOpen = !projectPickerOpen;
                  setProjectPickerOpen(nextOpen);
                  if (nextOpen) requestAnimationFrame(() => projectInputRef.current?.focus());
                  else requestAnimationFrame(() => textRef.current?.focus());
                }}
              >
                <span className="s-newchat-project-summary-title">
                  {selectedProject ? `/${selectedProject.title}` : "Choose a project"}
                </span>
                {selectedProject ? (
                  <span className="s-newchat-project-summary-path" title={selectedProject.root}>
                    {shortProjectPath(selectedProject.root)}
                  </span>
                ) : (
                  <span className="s-newchat-project-summary-path">Required when you send</span>
                )}
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            </div>

            {projectReminder ? (
              <p id="s-newchat-project-reminder" className="s-newchat-project-reminder" role="alert">
                {projectReminder}
              </p>
            ) : null}

            {projectPickerOpen ? (
              <div id="s-newchat-project-panel" className="s-newchat-project-panel">
                <div className="s-newchat-project-picker">
                  <Search size={13} aria-hidden="true" className="s-newchat-project-search-icon" />
                  <input
                    ref={projectInputRef}
                    id="s-newchat-project-search"
                    className="s-newchat-project-search"
                    type="search"
                    role="combobox"
                    aria-label="Filter projects or enter a project path"
                    aria-autocomplete="list"
                    aria-expanded="true"
                    aria-controls="s-newchat-project-results"
                    aria-activedescendant={projectOptionCount > 0
                      ? `s-newchat-project-option-${activeProjectIndex}`
                      : undefined}
                    value={projectQuery}
                    placeholder={configuration ? "Filter projects, or type a path…" : "Loading projects…"}
                    disabled={isStarting}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      setProjectQuery(event.currentTarget.value);
                      setActiveProjectIndex(0);
                    }}
                    onKeyDown={handleProjectKeyDown}
                  />
                </div>

                <div
                  id="s-newchat-project-results"
                  className="s-newchat-project-results"
                  role="listbox"
                  aria-label="Projects"
                >
                  {visibleProjects.map((project, index) => (
                    <div
                      key={project.root}
                      id={`s-newchat-project-option-${index}`}
                      role="option"
                      aria-selected={project.root === projectPath}
                      aria-disabled={isStarting || undefined}
                      className="s-newchat-project-option"
                      data-active={index === activeProjectIndex || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveProjectIndex(index)}
                      onClick={() => {
                        if (isStarting) return;
                        selectProject(project);
                      }}
                    >
                      <span className="s-newchat-project-option-title">/{project.title}</span>
                      <span className="s-newchat-project-option-path">{shortProjectPath(project.root)}</span>
                    </div>
                  ))}
                  {directPathCandidate ? (
                    <div
                      id={`s-newchat-project-option-${visibleProjects.length}`}
                      role="option"
                      aria-selected={directPathCandidate === projectPath}
                      aria-disabled={isStarting || undefined}
                      className="s-newchat-project-option s-newchat-project-option--path"
                      data-active={activeProjectIndex === visibleProjects.length || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveProjectIndex(visibleProjects.length)}
                      onClick={() => {
                        if (isStarting) return;
                        selectDirectPath(directPathCandidate);
                      }}
                    >
                      <span className="s-newchat-project-option-title">Use this project path</span>
                      <span className="s-newchat-project-option-path">{shortProjectPath(directPathCandidate)}</span>
                    </div>
                  ) : null}
                  {visibleProjects.length === 0 && !directPathCandidate ? (
                    <p className="s-newchat-project-empty">
                      No project matched. Type an absolute path such as ~/dev/my-project.
                    </p>
                  ) : null}
                </div>

                <div className="s-newchat-project-panel-foot">
                  {projectsHeldBack > 0 ? (
                    <p className="s-newchat-project-foot">
                      {visibleProjects.length} of{" "}
                      {projectQuery.trim() ? filteredProjects.length : projectTargets.length}
                      {projectQuery.trim() ? " matches" : " projects"} · type to narrow
                    </p>
                  ) : <span />}
                  {selectedProject ? (
                    <button type="button" className="s-newchat-project-clear" onClick={clearProject}>
                      Clear project
                    </button>
                  ) : null}
                </div>

                {projectLoadError && projectTargets.length === 0 ? (
                  <div className="s-newchat-error" role="alert">{projectLoadError}</div>
                ) : null}
              </div>
            ) : null}

            {isForwarding && initialForwardContext ? (
              <div className="s-newchat-forward-config">
                <div className="s-newchat-field">
                  <span className="label-md s-newchat-field-label">Runtime</span>
                  <div className="s-newchat-forward-runtime">
                    <RuntimePicker
                      catalog={runtimeCatalog}
                      value={{ harness, model, effort: reasoningEffort }}
                      onChange={handleRuntimeChange}
                      status="ready"
                      disabled={isStarting || !usesNewWorker}
                    />
                  </div>
                  {usesNewWorker && (runnerLoadError || selectedHarness?.ready === false) ? (
                    <p className="s-newchat-runtime-note" role="alert">
                      {selectedHarness?.ready === false
                        ? (selectedHarness.detail || `${selectedHarness.label} is unavailable.`)
                        : runnerLoadError}
                    </p>
                  ) : null}
                </div>

                <div className="s-newchat-field">
                  <span id="s-newchat-forward-context-label" className="label-md s-newchat-field-label">
                    Context
                  </span>
                  <div
                    className="s-newchat-context-options"
                    role="radiogroup"
                    aria-labelledby="s-newchat-forward-context-label"
                  >
                    <button
                      type="button"
                      className="s-newchat-context-option"
                      role="radio"
                      aria-checked={forwardContextMode === "selected-message"}
                      disabled={isStarting}
                      onClick={() => setForwardContextMode("selected-message")}
                    >
                      <span className="s-newchat-context-option-title">Selected message</span>
                      <span className="s-newchat-context-option-copy">Carry only the message you chose.</span>
                    </button>
                    <button
                      type="button"
                      className="s-newchat-context-option"
                      role="radio"
                      aria-checked={forwardContextMode === "recent-context"}
                      disabled={isStarting || initialForwardContext.recentMessageCount === 0}
                      onClick={() => setForwardContextMode("recent-context")}
                    >
                      <span className="s-newchat-context-option-title">Recent context + message</span>
                      <span className="s-newchat-context-option-copy">
                        {initialForwardContext.recentMessageCount > 0
                          ? `Carry ${initialForwardContext.recentMessageCount} preceding visible ${initialForwardContext.recentMessageCount === 1 ? "message" : "messages"}, then this message.`
                          : "No preceding visible messages are available."}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="s-newchat-context-option"
                      role="radio"
                      aria-checked={forwardContextMode === "instructions-only"}
                      disabled={isStarting}
                      onClick={() => setForwardContextMode("instructions-only")}
                    >
                      <span className="s-newchat-context-option-title">Instructions only</span>
                      <span className="s-newchat-context-option-copy">Start clean without source conversation text.</span>
                    </button>
                  </div>
                  <p className="s-newchat-context-note">
                    Recent context is a bounded Scout excerpt, not a generated summary or full model context.
                  </p>
                </div>
              </div>
            ) : null}

            {isForwarding ? (
              <span className="label-md s-newchat-field-label">Instructions</span>
            ) : null}
            <MessageComposer
              density="panel"
              value={message}
              onChange={handleMessageChange}
              onSend={() => void start()}
              sendOnEnter
              textareaRef={textRef}
              placeholder={isForwarding
                ? "Add what the new task should do (optional)…"
                : hasAttachments
                ? "What should the agent do with this?"
                : "Describe the task, or leave blank…"}
              aria-label={isForwarding ? "Instructions for the new task" : "Message"}
              disabled={isStarting}
              sending={isStarting}
              canSend={!isStarting && !runtimeBlocked && (!isForwarding || Boolean(committedMessage))}
              rows={7}
              maxHeightPx={280}
              sendTitle={isForwarding
                ? "Forward to new task (Enter)"
                : hasAttachments
                  ? "Route (Enter)"
                  : "Start task (Enter)"}
              sendAriaLabel={isForwarding ? "Forward to new task" : hasAttachments ? "Route capture" : "Start task"}
              overlay={(
                <>
                  {slashState.open ? (
                    <MessageComposerSuggestions
                      label="Slash commands"
                      placement="inside"
                      items={filteredSlashCommands.map((command) => ({
                        id: command.command,
                        token: command.label,
                        description: command.description,
                      }))}
                      activeIndex={slashState.index}
                      onPick={(index) => {
                        const command = filteredSlashCommands[index];
                        if (command) applySlashCommand(command);
                      }}
                      onActiveIndexChange={(index) => setSlashState((current) => ({ ...current, index }))}
                    />
                  ) : null}
                  {mentionState.open ? (
                    <MessageComposerSuggestions
                      label="Mention agent"
                      placement="inside"
                      items={filteredMentions.map((mention) => ({
                        id: mention.id,
                        token: `@${mention.handle}`,
                        description: mention.name,
                        avatar: {
                          label: mention.name[0]?.toUpperCase() ?? "?",
                          color: actorColor(mention.name),
                        },
                      }))}
                      activeIndex={mentionState.index}
                      onPick={(index) => {
                        const mention = filteredMentions[index];
                        if (mention) applyMention(mention);
                      }}
                      onActiveIndexChange={(index) => setMentionState((current) => ({ ...current, index }))}
                    />
                  ) : null}
                </>
              )}
              onSelect={(event) => {
                const field = event.currentTarget;
                updateMessageTriggers(field.value, field.selectionStart);
              }}
              onBlur={() => window.setTimeout(closeSuggestions, 120)}
              onKeyDown={handleMessageKeyDown}
              leadingTools={(
                <div className="s-newchat-compose-triggers" aria-label="Message shortcuts">
                  <button
                    type="button"
                    className="s-newchat-command-trigger"
                    disabled={isStarting}
                    onClick={() => insertComposerTrigger("/")}
                  >
                    /Commands
                  </button>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="s-newchat-command-trigger"
                    disabled={isStarting}
                    onClick={() => insertComposerTrigger("@")}
                  >
                    @Agents
                  </button>
                </div>
              )}
              tools={isForwarding ? undefined : (
                <RuntimePicker
                  catalog={runtimeCatalog}
                  value={{ harness, model, effort: reasoningEffort }}
                  onChange={handleRuntimeChange}
                  status="ready"
                  disabled={isStarting || !usesNewWorker}
                />
              )}
            />

            {files.length > 0 ? (
              <div className="s-newchat-attachments" aria-label="Attached captures">
                {files.map((file, index) => (
                  <AttachmentPreview
                    key={`${file.name}:${file.size}:${index}`}
                    file={file}
                    onRemove={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  />
                ))}
              </div>
            ) : null}

            {attachmentFeedback ? (
              <div className="s-newchat-attachment-feedback" role="status" aria-live="polite">
                {attachmentFeedback}
              </div>
            ) : null}

            {error && <div className="s-newchat-error" role="alert">{error}</div>}

            {isStarting && (
              <div className="s-newchat-progress" role="status" aria-live="polite">
                <Loader2 size={14} className="s-newchat-progress-spinner" aria-hidden="true" />
                <div className="s-newchat-progress-copy">
                  <span className="label-md s-newchat-progress-title">{phaseLabel}</span>
                  <span className="s-newchat-progress-detail">{progressDetail}</span>
                  {committedMessage && (
                    <span className="s-newchat-progress-message">{committedMessage}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {showConfig ? (
            <div className="s-newchat-config">
              {showDeliveryMode ? (
                <div className="s-newchat-mode" role="group" aria-label="Delivery mode">
                  <button
                    type="button"
                    className={`s-newchat-mode-btn${mode === "existing-chat" ? " s-newchat-mode-btn--on" : ""}`}
                    disabled={isStarting}
                    onClick={() => setMode("existing-chat")}
                  >
                    Existing chat
                  </button>
                  <button
                    type="button"
                    className={`s-newchat-mode-btn${mode === "new-session" ? " s-newchat-mode-btn--on" : ""}`}
                    disabled={isStarting}
                    onClick={() => setMode("new-session")}
                  >
                    New chat
                  </button>
                </div>
              ) : null}

              {usesNewWorker && (runnerLoadError || selectedHarness?.ready === false) ? (
                <p className="s-newchat-runtime-note" role="alert">
                  {selectedHarness?.ready === false
                    ? (selectedHarness.detail || `${selectedHarness.label} is unavailable.`)
                    : runnerLoadError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Edges, not a control strip: the panel is a window here, so the grips
            stay invisible until the pointer finds them. */}
        <div
          className="s-newchat-resize s-newchat-resize--e"
          aria-hidden="true"
          title="Drag to resize"
          {...gestureHandlers("e")}
        />
        <div
          className="s-newchat-resize s-newchat-resize--s"
          aria-hidden="true"
          title="Drag to resize"
          {...gestureHandlers("s")}
        />
        <div
          className="s-newchat-resize s-newchat-resize--se"
          aria-hidden="true"
          title="Drag to resize"
          {...gestureHandlers("se")}
        />
      </div>
    </div>
  );
}
