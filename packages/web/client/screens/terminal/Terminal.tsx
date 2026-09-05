import "./terminal-screen.css";

import {
  ExternalLink,
  Eye,
  Grid2X2,
  GripHorizontal,
  LogIn,
  MoreHorizontal,
  Plus,
  Power,
  RefreshCw,
  Square,
  Terminal as TerminalIcon,
  X,
  Zap,
} from "lucide-react";
import {
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useContextMenu } from "../../components/ContextMenu.tsx";
import { api } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { actorColor } from "../../lib/colors.ts";
import {
  resolveScoutTerminalRelayHealthUrl,
  resolveScoutTerminalRelayUrl,
} from "../../lib/runtime-config.ts";
import {
  absoluteRouteUrl,
  buildTerminalRouteBase,
  clearTerminalRelayStorage,
  controlTerminalSurface,
  destroyTerminalRelaySession,
  resolveAgentTerminalSurface,
  resolveTerminalRelayBinding,
  SCOUT_TERMINAL_INITIAL_COLS,
  SCOUT_TERMINAL_INITIAL_ROWS,
  shouldBootstrapTakeover,
  withTerminalMode,
} from "../../lib/terminal-relay.ts";
import {
  fetchTerminalSessions,
  compactTerminalName,
  compactTerminalPath,
  partitionTerminalListItems,
  resolveRegisteredTerminalTarget,
  surfaceKey,
  surfaceKeyFromParts,
  terminalConditionLabel,
  terminalListItems,
  terminalSummaryDetailRows,
  terminalSurfaceDescriptorFromRegisteredSurface,
  isRelayCapableTerminalBackend,
  terminalSurfaceIdsEqual,
  terminalSurfaceMatchesId,
  type RegisteredTerminalTarget,
} from "../../lib/terminal-sessions.ts";
import {
  closeTerminalWorkspace,
  emptyTerminalWorkspaceDeck,
  moveTerminalWorkspaceItem,
  selectTerminalWorkspace,
  TERMINAL_WORKSPACE_MAX_COLUMNS,
  updateTerminalWorkspace,
  upsertTerminalWorkspace,
  terminalWorkspaceDropPlacement,
} from "../../lib/terminal-workspace.ts";
import {
  createFreshTerminalCell,
  createTerminalDeckId,
  restoreTerminalWorkspaceDeck,
  terminalCellSessionName,
  terminalWorkspaceLayoutFromRecord,
  terminalWorkspaceRecordInputFromLayout,
  type TerminalCellBackend,
  TERMINAL_DEFAULT_GRID_COLUMNS,
  TERMINAL_WORKSPACES_STORAGE_KEY,
  TERMINAL_WORKSPACES_STORAGE_VERSION,
  TERMINAL_WORKSPACE_VIEW_STORAGE_KEY,
  type TerminalWorkspaceCellDefinition,
  type TerminalWorkspaceDeckState,
  type TerminalWorkspaceDefinition,
} from "./workspace-deck.ts";
import {
  createTerminalHostSession,
  terminalHostById,
  terminalHostSupportsControl,
  terminalStartOptions,
  useTerminalHosts,
  type TerminalStartOption,
} from "../../lib/terminal-hosts.ts";
import {
  DEFAULT_TERMINAL_SESSION_SORT,
  sortTerminalSessionItems,
  terminalSessionActivityAt,
  terminalSessionStateLabel,
  TERMINAL_SESSION_COLUMNS,
  toggleTerminalSessionSort,
  type TerminalSessionColumn,
  type TerminalSessionSort,
} from "./session-table.ts";
import {
  fetchTerminalWorkspaces,
  removeTerminalWorkspace,
  reviveTerminalWorkspaceCell,
  saveTerminalWorkspace,
  terminalWorkspaceCellStatuses,
  type TerminalWorkspaceResolution,
} from "../../lib/terminal-workspaces.ts";
import { useTerminalRelay, TerminalRelay } from "hudsonkit/terminal";
import { usePersistentState } from "@hudsonkit";
import { queueTakeover } from "../../lib/terminal-takeover.ts";
import { useHerdrTopology } from "../../lib/herdr-topology.ts";
import { AgentStatusDot, HerdrSessionScreen, herdrTabSummary, herdrTerminalRoute } from "./HerdrSession.tsx";
import {
  SCOUT_TERMINAL_SEND_LINE_EVENT,
  terminalHostLineFromEvent,
} from "../../lib/terminal-host-command.ts";
import { agentStateLabel } from "../../lib/agent-state.ts";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { TmuxPeekPanel } from "../../scout/inspector/TmuxPeek.tsx";
import {
  parseTerminalSurfaceId,
  resolveTerminalWorkspaceColumns,
  terminalWorkspaceLayoutLabel,
  terminalWorkspaceLayoutOf,
} from "@openscout/protocol";
import type {
  TerminalSessionRecord,
  TerminalWorkspaceColumnCount,
  TerminalWorkspaceLayout,
  TerminalWorkspaceLayoutMode,
} from "@openscout/protocol";
import type { MenuItem } from "../../components/ContextMenu.tsx";
import type { Agent, Route, SessionCatalogWithResume, TerminalSurfaceDescriptor } from "../../lib/types.ts";
import type { useScout as UseScout } from "../../scout/Provider.tsx";
import { TerminalHeaderMount } from "./TerminalHeaderMount.tsx";
import {
  nextTerminalPickerSource,
  terminalPickerPanelId,
  terminalPickerTabId,
  type TerminalPickerSource,
} from "./terminal-picker-navigation.ts";

export type TerminalNavigate = ReturnType<typeof UseScout>["navigate"];
export type TerminalRoute = Extract<Route, { view: "terminal" }>;
type HudsonTerminalRelayOptions = Parameters<typeof useTerminalRelay>[0];
type ScoutTerminalRelayOptions = Omit<HudsonTerminalRelayOptions, "backend"> & {
  backend?: "pty" | "tmux" | "zellij";
  terminalSession?: string;
  zellijSession?: string;
  zellijSocketDir?: string;
};

export type TerminalContentProps = {
  route: TerminalRoute;
  navigate: TerminalNavigate;
};

/** @deprecated Prefer {@link TerminalContent} with a terminal route. */
export type TerminalScreenProps = {
  agentId?: string;
  mode?: "observe" | "takeover";
  terminalSessionId?: string;
  terminalSurfaceKey?: string;
  navigate: TerminalNavigate;
};

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type TerminalSessionsState =
  | { state: "loading"; sessions: Awaited<ReturnType<typeof fetchTerminalSessions>> }
  | { state: "ready"; sessions: Awaited<ReturnType<typeof fetchTerminalSessions>> }
  | { state: "failed"; sessions: Awaited<ReturnType<typeof fetchTerminalSessions>>; error: string };

type TerminalBackend = NonNullable<TerminalRoute["terminalBackend"]>;
type TerminalAgentKind = NonNullable<TerminalRoute["terminalAgent"]>;

type FreshTerminalTileModel = {
  id: string;
  kind: "fresh";
  backend: TerminalCellBackend;
  agent: TerminalAgentKind;
  sessionName?: string;
  zellijSocketDir?: string;
};

type RegisteredTerminalTileModel = {
  id: string;
  kind: "registered";
  target: RegisteredTerminalTarget;
};

type UnavailableTerminalTileModel = {
  id: string;
  kind: "unavailable";
  terminalSessionId: string;
  terminalSurfaceKey: string;
};

type TerminalWorkspaceTileModel =
  | FreshTerminalTileModel
  | RegisteredTerminalTileModel
  | UnavailableTerminalTileModel;
type TerminalLayoutModeOption = {
  mode: TerminalWorkspaceLayoutMode;
  label: string;
  detail: string;
  /** Cells the mode wants at minimum when an empty draft picks it. */
  minimumCells: number;
};

type TerminalWorkspaceView = "library" | "builder" | "workspace";
type TerminalPickerView = "list" | "table";

const TERMINAL_PICKER_VIEW_STORAGE_KEY = "openscout.terminal.picker-view.v1";
const TERMINAL_PICKER_SOURCE_STORAGE_KEY = "openscout.terminal.picker-source.v1";

/**
 * A new workspace opens as a grid that fits itself to the tiles in it, which is
 * the arrangement that stays right as the operator adds cells.
 */
const TERMINAL_DEFAULT_DRAFT_LAYOUT: TerminalWorkspaceLayout = { mode: "grid", columns: "dynamic" };

const TERMINAL_LAYOUT_MODES: readonly TerminalLayoutModeOption[] = [
  { mode: "solo", label: "Solo", detail: "One terminal, full width", minimumCells: 1 },
  { mode: "lanes", label: "Lanes", detail: "Side by side, one row", minimumCells: 2 },
  { mode: "grid", label: "Grid", detail: "Rows and columns", minimumCells: 4 },
];

const TERMINAL_FRESH_AGENT_OPTIONS: readonly { value: TerminalAgentKind; label: string }[] = [
  { value: "shell", label: "Shell" },
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "pi", label: "Pi" },
];

const DEFAULT_TERMINAL_FONT_FAMILY = "'JetBrainsMono Nerd Font', 'JetBrainsMonoNL Nerd Font', 'MesloLGS Nerd Font Mono', 'Hack Nerd Font Mono', 'JetBrains Mono', monospace";
const ignoreReadOnlyTerminalInput = (_value: string) => {};
const ignoreReadOnlyTerminalRestart = () => {};

function terminalTypography(): { fontFamily: string; fontSize: number } {
  if (typeof window === "undefined") {
    return { fontFamily: DEFAULT_TERMINAL_FONT_FAMILY, fontSize: 13 };
  }
  const params = new URLSearchParams(window.location.search);
  const configuredFamily = params.get("terminalFontFamily")?.trim();
  const configuredSize = Number(params.get("terminalFontSize"));
  return {
    fontFamily: configuredFamily
      ? `'${configuredFamily.replaceAll("'", "\\'")}', ${DEFAULT_TERMINAL_FONT_FAMILY}`
      : DEFAULT_TERMINAL_FONT_FAMILY,
    fontSize: Number.isFinite(configuredSize) && configuredSize >= 9 && configuredSize <= 32
      ? configuredSize
      : 13,
  };
}

function ScoutTerminalRelay(props: ComponentProps<typeof TerminalRelay>) {
  const typography = terminalTypography();
  // "auto" lets Hudson load @xterm/addon-webgl and fall back to the DOM
  // renderer on context loss. Callers can still pin "dom" or "webgl".
  return (
    <TerminalRelay
      {...props}
      renderer={props.renderer ?? "auto"}
      fontFamily={typography.fontFamily}
      fontSize={typography.fontSize}
    />
  );
}

type TerminalHomeListItem = ReturnType<typeof terminalListItems>[number];
type TerminalInventoryRow =
  | { id: string; kind: "session"; item: TerminalHomeListItem; matchingAgent: Agent | null; updatedAt: number }
  | { id: string; kind: "agent"; agent: Agent; updatedAt: number };

function useTerminalSessionsTarget(
  terminalSessionId: string | undefined,
  terminalSurfaceKey: string | undefined,
) {
  const [state, setState] = useState<TerminalSessionsState>({ state: "loading", sessions: [] });

  const loadSessions = useCallback(() => {
    setState((current) => ({ state: "loading", sessions: current.sessions }));
    void fetchTerminalSessions({ includeDiscovered: true })
      .then((sessions) => {
        setState({ state: "ready", sessions });
      })
      .catch((error) => {
        setState((current) => ({
          state: "failed",
          sessions: current.sessions,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const target = useMemo(
    () => resolveRegisteredTerminalTarget(state.sessions, terminalSessionId, terminalSurfaceKey),
    [state.sessions, terminalSessionId, terminalSurfaceKey],
  );

  return {
    target,
    loadState: state.state,
    loadSessions,
    hasSessionHint: Boolean(terminalSessionId),
  };
}

function useTerminalTakeoverBootstrap(
  agentId: string | undefined,
  agent: Agent | null,
  mode: "observe" | "takeover" | undefined,
) {
  const needsBootstrap = shouldBootstrapTakeover(agent, mode);
  const [state, setState] = useState<
    | { state: "ready" }
    | { state: "preparing" }
    | { state: "failed"; error: string }
  >(needsBootstrap ? { state: "preparing" } : { state: "ready" });
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!needsBootstrap || !agentId) {
      setState({ state: "ready" });
      return;
    }

    let cancelled = false;
    setState({ state: "preparing" });

    api<SessionCatalogWithResume>(`/api/agents/${encodeURIComponent(agentId)}/session-catalog`)
      .then((catalog) => {
        if (!catalog.resumeCommand) return;
        return queueTakeover({
          command: catalog.resumeCommand,
          cwd: catalog.resumeCwd,
          agentId,
        });
      })
      .then(() => {
        if (!cancelled) setState({ state: "ready" });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, needsBootstrap, retryNonce]);

  return {
    ready: state.state === "ready",
    label: state.state === "failed" ? "TAKEOVER FAILED" : "PREPARING TAKEOVER",
    status: state.state === "failed" ? state.error : "Resolving live session...",
    onRetry: state.state === "failed" ? () => setRetryNonce((value) => value + 1) : undefined,
  };
}

function useTerminalRelaySession(params: {
  agentId?: string;
  agent: Agent | null;
  mode?: "observe" | "takeover";
  navigate: (route: Route) => void;
  registeredTarget?: RegisteredTerminalTarget;
  showContextMenu: (event: ReactMouseEvent, items: MenuItem[]) => void;
}) {
  const { agentId, agent, mode, navigate, registeredTarget, showContextMenu } = params;
  const { hosts: terminalHosts } = useTerminalHosts();
  const color = agent ? actorColor(agent.name) : "var(--accent)";
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const terminalSurface: TerminalSurfaceDescriptor | null = registeredTarget
    ? terminalSurfaceDescriptorFromRegisteredSurface(registeredTarget.surface)
    : resolveAgentTerminalSurface(agent);
  const readOnly = mode === "observe";
  const cwd = registeredTarget?.session.cwd ?? agent?.cwd ?? agent?.projectRoot ?? undefined;
  const relayUrl = resolveScoutTerminalRelayUrl();
  const healthUrl = resolveScoutTerminalRelayHealthUrl();
  const binding = resolveTerminalRelayBinding({
    agentId,
    agent,
    registeredTarget,
    terminalSurface,
    relayUrl,
    harness: registeredTarget?.session.harness ?? agent?.harness,
    cwd,
    mode,
  });
  const relay = useTerminalRelay({
    url: binding.scopedRelayUrl,
    healthUrl,
    autoConnect: true,
    // An observer reconnect must be a fresh tmux attach so tmux supplies an
    // authoritative full redraw. Replaying a raw ANSI byte tail is not a
    // valid terminal snapshot.
    ...(readOnly ? {} : { sessionKey: binding.relayStorageSessionKey }),
    ...(binding.surfaceOptions ?? {}),
    ...(binding.orphanTTL ? { orphanTTL: binding.orphanTTL } : {}),
    ...(binding.cwd ? { cwd: binding.cwd } : {}),
    ...(binding.relayAgent ? { agent: binding.relayAgent } : {}),
    controlMode: binding.controlMode,
  } as Parameters<typeof useTerminalRelay>[0]);

  useBrowserLayoutEffect(() => {
    relay.resize(SCOUT_TERMINAL_INITIAL_COLS, SCOUT_TERMINAL_INITIAL_ROWS);
  }, [relay.resize]);

  const terminalRelay = useMemo(() => {
    if (!readOnly) return relay;
    return {
      ...relay,
      sendInput: ignoreReadOnlyTerminalInput,
      sendLine: ignoreReadOnlyTerminalInput,
      restart: ignoreReadOnlyTerminalRestart,
    };
  }, [readOnly, relay]);

  const terminalRouteBase = buildTerminalRouteBase({ agentId, registeredTarget });
  const currentTerminalRoute = withTerminalMode(terminalRouteBase, mode);

  const focusTerminal = useCallback(() => {
    const root = terminalBodyRef.current;
    root?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    root?.querySelector<HTMLElement>(".xterm")?.focus();
  }, []);

  useEffect(() => {
    const textFromEvent = (event: Event): string | null => {
      const value = (event as CustomEvent<{ line?: unknown }>).detail?.line;
      return typeof value === "string" && value.length > 0 ? value : null;
    };
    const sendInput = (event: Event) => {
      const text = textFromEvent(event);
      if (!text || readOnly) return;
      terminalRelay.sendInput(text);
      focusTerminal();
    };
    const sendLine = (event: Event) => {
      const text = textFromEvent(event);
      if (!text || readOnly) return;
      terminalRelay.sendLine(text);
      focusTerminal();
    };

    window.addEventListener("scout:terminal-send-input", sendInput);
    window.addEventListener("scout:terminal-send-line", sendLine);
    return () => {
      window.removeEventListener("scout:terminal-send-input", sendInput);
      window.removeEventListener("scout:terminal-send-line", sendLine);
    };
  }, [focusTerminal, readOnly, terminalRelay]);

  const runSurfaceControl = useCallback((action: Parameters<typeof controlTerminalSurface>[1]) => {
    if (!terminalSurface) return null;
    return controlTerminalSurface(terminalSurface, action);
  }, [terminalSurface]);

  const copyTerminalLink = useCallback(() => {
    void copyTextToClipboard(absoluteRouteUrl(currentTerminalRoute));
  }, [currentTerminalRoute]);

  const pasteClipboard = useCallback(() => {
    if (readOnly || !navigator.clipboard?.readText) return;
    void navigator.clipboard.readText()
      .then((text) => {
        if (text) terminalRelay.sendInput(text);
      })
      .catch(() => {});
  }, [readOnly, terminalRelay]);

  const detachRelay = useCallback(() => {
    clearTerminalRelayStorage(binding.relayStorageSessionKey);
    const surfaceControl = runSurfaceControl("detach");
    if (surfaceControl) {
      void surfaceControl.finally(() => relay.disconnect());
      return;
    }
    relay.disconnect();
  }, [binding.relayStorageSessionKey, relay, runSurfaceControl]);

  const reconnectRelay = useCallback(() => {
    clearTerminalRelayStorage(binding.relayStorageSessionKey);
    const surfaceControl = runSurfaceControl("force-quit-bridge");
    if (surfaceControl) {
      void surfaceControl.finally(() => {
        relay.connect();
        window.setTimeout(focusTerminal, 250);
      });
      return;
    }
    relay.connect();
    window.setTimeout(focusTerminal, 250);
  }, [binding.relayStorageSessionKey, focusTerminal, relay, runSurfaceControl]);

  const interruptTerminal = useCallback(() => {
    if (readOnly) return;
    const surfaceControl = runSurfaceControl("interrupt");
    if (surfaceControl) {
      void surfaceControl.catch(() => terminalRelay.sendInput("\x03"));
    } else {
      terminalRelay.sendInput("\x03");
    }
    focusTerminal();
  }, [focusTerminal, readOnly, runSurfaceControl, terminalRelay]);

  const quitTerminal = useCallback(() => {
    if (readOnly) return;
    const surfaceControl = runSurfaceControl("quit");
    if (surfaceControl) {
      void surfaceControl.catch(() => terminalRelay.sendInput("\x04"));
    } else {
      terminalRelay.sendInput("\x04");
    }
    focusTerminal();
  }, [focusTerminal, readOnly, runSurfaceControl, terminalRelay]);

  const stopTerminalJob = useCallback(() => {
    if (readOnly) return;
    const surfaceControl = runSurfaceControl("stop-job");
    if (surfaceControl) {
      void surfaceControl.finally(focusTerminal);
      return;
    }
    focusTerminal();
  }, [focusTerminal, readOnly, runSurfaceControl]);

  const forceQuitClaudeInstance = useCallback(() => {
    clearTerminalRelayStorage(binding.relayStorageSessionKey);
    if (terminalSurface && !window.confirm(`Force quit Claude in ${compactTerminalName(terminalSurface.sessionName)}?`)) {
      return;
    }
    const surfaceControl = runSurfaceControl("force-quit");
    if (surfaceControl) {
      void surfaceControl.finally(() => relay.disconnect());
      return;
    }
    const sessionId = relay.sessionId;
    if (!sessionId) {
      relay.disconnect();
      return;
    }
    void destroyTerminalRelaySession(sessionId)
      .catch(() => {})
      .finally(() => relay.disconnect());
  }, [binding.relayStorageSessionKey, relay, runSurfaceControl, terminalSurface]);

  const restartResumeClaudeInstance = useCallback(() => {
    if (!terminalSurface) return;
    if (!window.confirm(`Restart Claude in ${compactTerminalName(terminalSurface.sessionName)} and resume its latest session?`)) {
      return;
    }
    clearTerminalRelayStorage(binding.relayStorageSessionKey);
    const surfaceControl = runSurfaceControl("restart-resume");
    if (surfaceControl) {
      void surfaceControl.finally(() => {
        relay.disconnect();
        window.setTimeout(() => {
          relay.connect();
          window.setTimeout(focusTerminal, 250);
        }, 600);
      });
    }
  }, [binding.relayStorageSessionKey, focusTerminal, relay, runSurfaceControl, terminalSurface]);

  const openMode = useCallback((nextMode: "observe" | "takeover") => {
    navigate(withTerminalMode(terminalRouteBase, nextMode));
  }, [navigate, terminalRouteBase]);

  const openSummary = useCallback(() => {
    navigate(terminalRouteBase);
  }, [navigate, terminalRouteBase]);

  const hasViewActions = Boolean(registeredTarget || terminalSurface);
  const canSignalTerminal = !readOnly && Boolean(terminalSurface || relay.status === "connected");
  const canStopTerminalJob = !readOnly && Boolean(terminalSurface);

  // Actions are drawn from what the host declares it can do. A host that cannot
  // restart a harness simply has no entry for it, instead of an entry whose
  // route answers 501 after the click.
  const relayMenuItems = useMemo<MenuItem[]>(() => {
    const backend = terminalSurface?.backend ?? null;
    const supports = (action: Parameters<typeof terminalHostSupportsControl>[2]) =>
      terminalHostSupportsControl(terminalHosts, backend, action);
    const items: MenuItem[] = [];
    if (!backend || supports("detach")) {
      items.push({ kind: "action", label: "Leave this session running", onSelect: detachRelay });
    }
    items.push({ kind: "action", label: "Reconnect", onSelect: reconnectRelay });
    const harnessItems: MenuItem[] = [];
    if (supports("restart-resume")) {
      harnessItems.push({ kind: "action", label: "Restart Claude and resume", onSelect: restartResumeClaudeInstance });
    }
    if (supports("force-quit")) {
      harnessItems.push({ kind: "action", label: "Force quit Claude", onSelect: forceQuitClaudeInstance });
    }
    if (harnessItems.length > 0) items.push({ kind: "separator" }, ...harnessItems);
    return items;
  }, [
    detachRelay,
    forceQuitClaudeInstance,
    reconnectRelay,
    restartResumeClaudeInstance,
    terminalHosts,
    terminalSurface?.backend,
  ]);

  // The Session button carries the signal and view actions too, gated the
  // same way as the bar buttons, so an embedded tile with no bar still
  // reaches them.
  const sessionMenuItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [...relayMenuItems];
    const signalItems: MenuItem[] = [];
    if (canSignalTerminal) {
      signalItems.push(
        { kind: "action", label: "Send Ctrl-C", shortcut: "⌃C", onSelect: interruptTerminal },
        { kind: "action", label: "Quit With Ctrl-D", shortcut: "⌃D", onSelect: quitTerminal },
      );
    }
    if (canStopTerminalJob) {
      signalItems.push({ kind: "action", label: "Stop Running Job", onSelect: stopTerminalJob });
    }
    if (signalItems.length > 0) items.push({ kind: "separator" }, ...signalItems);
    const viewItems: MenuItem[] = [];
    if (terminalSurface) {
      viewItems.push({
        kind: "action",
        label: readOnly ? "Open Takeover" : "Open Observe",
        onSelect: () => openMode(readOnly ? "takeover" : "observe"),
      });
    }
    if (registeredTarget) {
      viewItems.push({ kind: "action", label: "Open Summary", onSelect: openSummary });
    }
    if (viewItems.length > 0) items.push({ kind: "separator" }, ...viewItems);
    return items;
  }, [
    canSignalTerminal,
    canStopTerminalJob,
    interruptTerminal,
    openMode,
    openSummary,
    quitTerminal,
    readOnly,
    registeredTarget,
    relayMenuItems,
    stopTerminalJob,
    terminalSurface,
  ]);

  const handleSessionMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    showContextMenu(event, sessionMenuItems);
  }, [sessionMenuItems, showContextMenu]);

  const handleTerminalContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const selection = typeof window === "undefined" ? "" : window.getSelection()?.toString() ?? "";
    const items: MenuItem[] = [];
    if (selection.trim()) {
      items.push({
        kind: "action",
        label: "Copy Selection",
        shortcut: "⌘C",
        onSelect: () => void copyTextToClipboard(selection),
      });
    }
    if (!readOnly) {
      items.push(
        { kind: "action", label: "Paste", shortcut: "⌘V", onSelect: pasteClipboard },
        { kind: "action", label: "Send Ctrl-C", shortcut: "⌃C", onSelect: interruptTerminal },
        { kind: "action", label: "Quit With Ctrl-D", shortcut: "⌃D", onSelect: quitTerminal },
        { kind: "action", label: "Stop Running Job", onSelect: stopTerminalJob },
      );
    }
    if (items.length > 0) items.push({ kind: "separator" });
    items.push(
      { kind: "action", label: "Focus Terminal", onSelect: focusTerminal },
      ...relayMenuItems,
      { kind: "separator" },
      {
        kind: "action",
        label: readOnly ? "Open Takeover" : "Open Observe",
        onSelect: () => openMode(readOnly ? "takeover" : "observe"),
      },
      { kind: "action", label: "Open Summary", onSelect: openSummary },
      { kind: "action", label: "Copy Terminal Link", onSelect: copyTerminalLink },
    );
    showContextMenu(event, items);
  }, [
    copyTerminalLink,
    focusTerminal,
    interruptTerminal,
    openMode,
    openSummary,
    pasteClipboard,
    quitTerminal,
    readOnly,
    relayMenuItems,
    showContextMenu,
    stopTerminalJob,
  ]);

  return {
    color,
    terminalBodyRef,
    terminalSurface,
    readOnly,
    relay,
    terminalRelay,
    healthUrl,
    scopedRelayUrl: binding.scopedRelayUrl,
    hasViewActions,
    canSignalTerminal,
    canStopTerminalJob,
    handleSessionMenu,
    handleTerminalContextMenu,
    openMode,
    openSummary,
    interruptTerminal,
    quitTerminal,
    stopTerminalJob,
    terminalRouteBase: terminalRouteBase as TerminalRoute,
  };
}

function TerminalPlaceholder({
  agent,
  agentId,
  color,
  navigate,
  label,
  status,
  onRetry,
}: {
  agent: Agent | null;
  agentId?: string;
  color: string;
  navigate: (route: Route) => void;
  label: string;
  status: string;
  onRetry?: () => void;
}) {
  return (
    <div className="s-term">
      <div className="s-term-bar">
        <BackToPicker
          slot="terminal"
          fallback={{ view: "terminal" }}
          navigate={navigate}
          className="s-term-back"
        />
        {agent && (
          <div className="s-term-agent">
            <div
              className="s-ops-avatar"
              style={{ "--size": "18px", background: color } as CSSProperties}
            >
              {agent.name[0]?.toUpperCase()}
            </div>
            <span className="s-term-agent-name">{agent.name}</span>
            {agent.handle && (
              <span className="s-term-agent-handle">@{agent.handle}</span>
            )}
          </div>
        )}
        <span className="s-term-label">{label}</span>
        <div className="s-term-status">
          {onRetry ? "OFFLINE" : "CONNECTING"}
        </div>
      </div>
      <div className="s-term-body s-term-body--placeholder">
        <div className="s-term-placeholder">
          <span>{status}</span>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TerminalSummary({
  target,
  navigate,
}: {
  target: RegisteredTerminalTarget;
  navigate: (route: Route) => void;
}) {
  const item = useMemo(
    () => terminalListItems([target.session]).find((candidate) => surfaceKey(candidate.surface) === surfaceKey(target.surface)),
    [target],
  );
  const routeBase = {
    view: "terminal" as const,
    terminalSessionId: target.session.id,
    terminalSurfaceKey: surfaceKey(target.surface),
  };
  const condition = terminalConditionLabel(target.session, target.surface);
  const detailRows = terminalSummaryDetailRows(target);

  return (
    <div className="s-term s-term--summary">
      <div className="s-term-summary">
        <div className="s-term-summary-main">
          <BackToPicker
            slot="terminal"
            fallback={{ view: "terminal" }}
            navigate={navigate}
            className="s-term-back"
          />
          <div className="s-term-summary-mark">
            <TerminalIcon size={18} strokeWidth={1.7} />
            <span>Terminal</span>
          </div>
          <div className="s-term-summary-heading">
            <h1>{item?.title ?? target.surface.sessionName}</h1>
            <p>{target.surface.backend} · {condition}</p>
          </div>
          <div className="s-term-summary-actions">
            <button
              type="button"
              className="s-term-summary-action s-term-summary-action--primary"
              onClick={() => navigate(withTerminalMode(routeBase, "takeover"))}
            >
              <LogIn size={14} strokeWidth={1.8} />
              <span>Enter</span>
            </button>
            <button
              type="button"
              className="s-term-summary-action"
              onClick={() => navigate(withTerminalMode(routeBase, "observe"))}
            >
              <Eye size={14} strokeWidth={1.8} />
              <span>Observe</span>
            </button>
          </div>
        </div>
        <div className="s-term-summary-preview">
          <TmuxPeekPanel
            surface={terminalSurfaceDescriptorFromRegisteredSurface(target.surface)}
            lines={26}
            columns={112}
            pollMs={30_000}
            idlePollMs={30_000}
            className="s-term-preview-peek"
          />
        </div>
        <dl className="s-term-summary-details">
          {detailRows.map(([label, value]) => (
            <div key={label} className="s-term-summary-detail">
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function TerminalRelayCanvas({
  agentId,
  agent,
  mode,
  navigate,
  registeredTarget,
  embedded = false,
  tileActions,
}: {
  agentId?: string;
  agent: Agent | null;
  mode?: "observe" | "takeover";
  navigate: (route: Route) => void;
  registeredTarget?: RegisteredTerminalTarget;
  embedded?: boolean;
  tileActions?: ReactNode;
}) {
  const showContextMenu = useContextMenu();
  const session = useTerminalRelaySession({
    agentId,
    agent,
    mode,
    navigate,
    registeredTarget,
    showContextMenu,
  });

  const relayStatusLabel = session.relay.status === "connected"
    ? "LIVE"
    : session.relay.status === "connecting"
      ? "CONNECTING"
      : "OFFLINE";
  const relayStatusTone = session.relay.status === "connected"
    ? "live"
    : session.relay.status === "connecting"
      ? "connecting"
      : "offline";

  return (
    <div className={`s-term${embedded ? " s-term--embedded" : ""}`}>
      {/* An embedded tile sits under its host's own header (native tile chrome
          or the workspace cell), so the takeover strip would be a second band.
          Its controls fold into a floating cluster over the canvas instead. */}
      {!embedded && (
      <div className="s-term-bar s-term-bar--takeover">
        <div className="s-term-bar-left">
          <BackToPicker
            slot="terminal"
            fallback={{ view: "terminal" }}
            navigate={navigate}
            className="s-term-back"
          />
          {agent && (
            <div className="s-term-agent">
              <div
                className="s-ops-avatar"
                style={{ "--size": "18px", background: session.color } as CSSProperties}
              >
                {agent.name[0]?.toUpperCase()}
              </div>
              <span className="s-term-agent-name">{agent.name}</span>
              {agent.handle && (
                <span className="s-term-agent-handle">@{agent.handle}</span>
              )}
            </div>
          )}
          {registeredTarget && (
            <div className="s-term-registered-chip">
              <TerminalIcon size={14} strokeWidth={1.8} />
              <span>{registeredTarget.session.harness}</span>
              <span>{registeredTarget.session.sourceSessionId}</span>
            </div>
          )}
        </div>
        <div className="s-term-bar-meta">
          <span className="s-term-label">
            {session.terminalSurface ? (session.readOnly ? "TERMINAL OBSERVE" : "TERMINAL TAKEOVER") : "TAKEOVER"}
          </span>
          {session.terminalSurface && (
            <span className="s-term-session" title={session.terminalSurface.sessionName}>
              {compactTerminalName(session.terminalSurface.sessionName)}
            </span>
          )}
        </div>
        <div className="s-term-bar-actions">
          {session.hasViewActions && (
            <div className="s-term-action-cluster s-term-action-cluster--view" aria-label="Terminal view actions">
              {registeredTarget && (
                <button
                  type="button"
                  className="s-term-action"
                  onClick={session.openSummary}
                  title="Leave the terminal canvas and show the session summary"
                >
                  Summary
                </button>
              )}
              {session.terminalSurface && (
                <button
                  type="button"
                  className="s-term-action"
                  onClick={() => session.openMode(session.readOnly ? "takeover" : "observe")}
                  title={session.readOnly ? "Switch to interactive takeover" : "Switch to read-only terminal observe"}
                >
                  {session.readOnly ? "Takeover" : "Observe"}
                </button>
              )}
            </div>
          )}
          {(session.canSignalTerminal || session.canStopTerminalJob) && (
            <div className="s-term-action-cluster s-term-action-cluster--signals" aria-label="Terminal signal actions">
              {session.canSignalTerminal && (
                <button
                  type="button"
                  className="s-term-action s-term-action--warn"
                  onClick={session.interruptTerminal}
                  title="Send Ctrl-C to the terminal"
                >
                  <Zap size={13} strokeWidth={1.8} />
                  <span>Ctrl-C</span>
                </button>
              )}
              {session.canSignalTerminal && (
                <button
                  type="button"
                  className="s-term-action s-term-action--warn"
                  onClick={session.quitTerminal}
                  title="Send Ctrl-D / EOF to the terminal"
                >
                  <Power size={13} strokeWidth={1.8} />
                  <span>Quit</span>
                </button>
              )}
              {session.canStopTerminalJob && (
                <button
                  type="button"
                  className="s-term-action s-term-action--warn"
                  onClick={session.stopTerminalJob}
                  title="Stop Claude's current shell/tool job without quitting Claude"
                >
                  <Square size={12} strokeWidth={2} />
                  <span>Stop Job</span>
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="s-term-action s-term-session-menu"
            onClick={session.handleSessionMenu}
            title="Open session, recovery, and external handoff actions"
          >
            <MoreHorizontal size={14} strokeWidth={1.8} />
            <span>Session</span>
          </button>
          <div className="s-term-status">{relayStatusLabel}</div>
          {tileActions}
        </div>
      </div>
      )}
      <div
        ref={session.terminalBodyRef}
        className="s-term-body"
        onContextMenuCapture={session.handleTerminalContextMenu}
      >
        {embedded && (
          <div className="s-term-float" aria-label="Terminal tile actions">
            {/* Pointer drag handle for the workspace grid (startTileDrag looks
                for it). preventDefault keeps the pointerdown from moving focus
                off xterm; keyboard reordering stays on the tile context menu. */}
            <span
              className="s-term-float-grip"
              title="Drag to move"
              aria-hidden="true"
              onPointerDown={(event) => event.preventDefault()}
            >
              <GripHorizontal size={14} strokeWidth={1.8} />
            </span>
            {registeredTarget && (
              <span
                className="s-term-float-identity"
                title={`${registeredTarget.session.harness} ${registeredTarget.session.sourceSessionId}`}
              >
                <span>{registeredTarget.session.harness}</span>
                <span>{registeredTarget.session.sourceSessionId}</span>
              </span>
            )}
            <span
              className={`s-term-float-mark s-term-float-mark--${relayStatusTone}`}
              role="status"
              title={relayStatusLabel}
              aria-label={`Relay ${relayStatusLabel.toLowerCase()}`}
            />
            <button
              type="button"
              className="s-term-icon-button"
              onClick={session.handleSessionMenu}
              title="Session actions"
              aria-label="Session actions"
            >
              <MoreHorizontal size={14} strokeWidth={1.8} />
            </button>
            {tileActions}
          </div>
        )}
        <ScoutTerminalRelay
          relay={session.terminalRelay}
          readOnly={session.readOnly}
          quiet
          configItems={[
            ...(session.terminalSurface
              ? [
                  { label: "backend", value: session.terminalSurface.backend },
                  { label: "session", value: session.terminalSurface.sessionName },
                  ...(session.terminalSurface.paneId ? [{ label: "pane", value: session.terminalSurface.paneId }] : []),
                  ...(session.terminalSurface.socketDir ? [{ label: "socket", value: session.terminalSurface.socketDir }] : []),
                  { label: "mode", value: session.readOnly ? "read-only" : "takeover" },
                ]
              : []),
            { label: "ws", value: session.scopedRelayUrl },
            { label: "health", value: session.healthUrl },
          ]}
        />
      </div>
    </div>
  );
}

function RegisteredTerminalSessions({
  terminalSessionId,
  terminalSurfaceKey,
  mode,
  navigate,
}: {
  terminalSessionId?: string;
  terminalSurfaceKey?: string;
  mode?: "observe" | "takeover";
  navigate: (route: Route) => void;
}) {
  const { target, loadState, loadSessions, hasSessionHint } = useTerminalSessionsTarget(
    terminalSessionId,
    terminalSurfaceKey,
  );

  if (target && mode) {
    return (
      <TerminalRelayCanvas
        key={`${surfaceKey(target.surface)}:${mode}`}
        agent={null}
        mode={mode}
        navigate={navigate}
        registeredTarget={target}
      />
    );
  }

  if (target) {
    return <TerminalSummary target={target} navigate={navigate} />;
  }

  return (
    <div className="s-term s-term--empty-main">
      <div className="s-term-empty-main-mark">
        <TerminalIcon size={18} strokeWidth={1.6} />
        <span>
          {loadState === "loading"
            ? "Loading terminal"
            : loadState === "failed"
              ? "Terminal list unavailable"
              : hasSessionHint
                ? "Terminal unavailable"
                : "Select a terminal"}
        </span>
        {loadState === "failed" && (
          <button type="button" className="s-term-empty-action" onClick={loadSessions}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** Whether a fresh tile's host session already exists in the live inventory. */
function isTileSessionLive(
  tile: TerminalWorkspaceTileModel,
  sessions: TerminalSessionRecord[],
): boolean {
  if (tile.kind !== "fresh" || !tile.sessionName) return false;
  return sessions.some((session) => session.surfaces.some((surface) =>
    surface.backend === tile.backend
    && surface.sessionName === tile.sessionName
    && surface.state !== "exited"
  ));
}

function registeredTerminalTargetKey(target: RegisteredTerminalTarget): string {
  return `${target.session.id}:${surfaceKey(target.surface)}`;
}

function terminalTileFromCell(
  cell: TerminalWorkspaceCellDefinition,
  sessions: TerminalSessionRecord[],
  workspaceId: string,
): TerminalWorkspaceTileModel {
  if (cell.kind === "fresh") {
    return {
      id: cell.id,
      kind: "fresh",
      backend: cell.backend,
      agent: cell.agent,
      // The workspace is part of the host session's identity: a cell id is only
      // unique inside its workspace, so without it two workspaces holding the
      // same slot id attach to one host session.
      ...(cell.backend === "pty"
        ? {}
        : { sessionName: terminalCellSessionName(cell.backend, cell.id, workspaceId) }),
    };
  }
  const target = resolveRegisteredTerminalTarget(sessions, cell.terminalSessionId, cell.terminalSurfaceKey);
  if (!target) {
    return {
      id: cell.id,
      kind: "unavailable",
      terminalSessionId: cell.terminalSessionId,
      terminalSurfaceKey: cell.terminalSurfaceKey,
    };
  }
  return { id: cell.id, kind: "registered", target };
}

function registeredTargetFromListItem(
  item: ReturnType<typeof terminalListItems>[number],
): RegisteredTerminalTarget {
  return { session: item.session, surface: item.surface };
}

/**
 * Standalone route for a fresh tile, or null for a host the browser relay
 * cannot render — there is no page to open for it, and offering one would be a
 * link to a tile that cannot connect.
 */
function freshTerminalRouteForTile(tile: FreshTerminalTileModel): TerminalRoute | null {
  const backend = tile.backend;
  if (backend !== "pty" && !isRelayCapableTerminalBackend(backend)) return null;
  return {
    view: "terminal",
    terminalBackend: backend,
    terminalAgent: tile.agent,
    terminalTabId: tile.id,
    ...(tile.sessionName ? { terminalSessionName: tile.sessionName } : {}),
    ...(tile.zellijSocketDir ? { zellijSocketDir: tile.zellijSocketDir } : {}),
  };
}

function registeredTerminalRouteForTarget(
  target: RegisteredTerminalTarget,
  mode: "observe" | "takeover" = "takeover",
): TerminalRoute {
  return {
    view: "terminal",
    terminalSessionId: target.session.id,
    terminalSurfaceKey: surfaceKey(target.surface),
    mode,
  };
}

function openTerminalRouteExternally(route: TerminalRoute, navigate: TerminalNavigate): void {
  if (typeof window === "undefined") {
    navigate(route);
    return;
  }
  window.open(absoluteRouteUrl(route), "_blank", "noopener,noreferrer");
}

function TerminalHome({ navigate }: { navigate: TerminalNavigate }) {
  const { agents } = useScout();
  const showContextMenu = useContextMenu();
  const { hosts: terminalHosts } = useTerminalHosts();
  // What can be started here is the registry's answer, not a literal list.
  const startOptions = useMemo(() => terminalStartOptions(terminalHosts), [terminalHosts]);
  const [deck, setDeck] = usePersistentState<TerminalWorkspaceDeckState>(
    TERMINAL_WORKSPACES_STORAGE_KEY,
    emptyTerminalWorkspaceDeck<TerminalWorkspaceCellDefinition>(),
    { version: TERMINAL_WORKSPACES_STORAGE_VERSION, migrate: restoreTerminalWorkspaceDeck },
  );
  const [storedWorkspaceView, setWorkspaceView] = usePersistentState<TerminalWorkspaceView>(
    TERMINAL_WORKSPACE_VIEW_STORAGE_KEY,
    "library",
  );
  // Workspaces Scout stores, and the exact record last written for each. Both
  // halves matter: the presence of an id says a workspace is server-backed at
  // all, and the signature is what keeps the write-through effect below from
  // echoing the server's own answer straight back at it.
  const syncedWorkspacesRef = useRef(new Map<string, string>());
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceDraftName, setWorkspaceDraftName] = useState("");
  const [workspaceDraftPurpose, setWorkspaceDraftPurpose] = useState("");
  const [workspaceDraftLayout, setWorkspaceDraftLayout] = useState<TerminalWorkspaceLayout>(
    TERMINAL_DEFAULT_DRAFT_LAYOUT,
  );
  const [workspaceDraftCells, setWorkspaceDraftCells] = useState<TerminalWorkspaceCellDefinition[]>(
    () => Array.from({ length: 4 }, () => createFreshTerminalCell("pty")),
  );
  const [workspaceDraftSlot, setWorkspaceDraftSlot] = useState(0);
  const [state, setState] = useState<TerminalSessionsState>({ state: "loading", sessions: [] });
  const [workspaceReload, setWorkspaceReload] = useState(0);
  const [pickerVisible, setPickerVisible] = useState(true);
  const [pickerView, setPickerView] = usePersistentState<TerminalPickerView>(
    TERMINAL_PICKER_VIEW_STORAGE_KEY,
    "list",
  );
  const [pickerSource, setPickerSource] = usePersistentState<TerminalPickerSource>(
    TERMINAL_PICKER_SOURCE_STORAGE_KEY,
    "multiplexer",
  );
  const [pickerSort, setPickerSort] = useState<TerminalSessionSort>(DEFAULT_TERMINAL_SESSION_SORT);
  const [selectedMultiplexerId, setSelectedMultiplexerId] = useState<string | null>(null);
  const [workspaceResolutions, setWorkspaceResolutions] = useState<TerminalWorkspaceResolution[]>([]);
  const [workspaceSyncError, setWorkspaceSyncError] = useState<string | null>(null);
  const [pickerDraggedTargetId, setPickerDraggedTargetId] = useState<string | null>(null);
  const [pickerDropTileId, setPickerDropTileId] = useState<string | null>(null);
  const [pickerDropNewSlot, setPickerDropNewSlot] = useState(false);
  const [draggedTileId, setDraggedTileId] = useState<string | null>(null);
  const [dropTargetTileId, setDropTargetTileId] = useState<string | null>(null);
  const tileDragRef = useRef<{ pointerId: number; tileId: string; startX: number; startY: number } | null>(null);
  const dropTargetTileIdRef = useRef<string | null>(null);
  const dropTargetEdgeRef = useRef<"before" | "after">("after");
  const pickerDragRef = useRef<{
    pointerId: number;
    target: RegisteredTerminalTarget;
    targetId: string;
    startX: number;
    startY: number;
  } | null>(null);
  const pickerDropTileIdRef = useRef<string | null>(null);
  const pickerDropNewSlotRef = useRef(false);

  const loadSessions = useCallback((options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setState((current) => ({ state: "loading", sessions: current.sessions }));
    }
    void fetchTerminalSessions({ includeDiscovered: true })
      .then((sessions) => setState({ state: "ready", sessions }))
      .catch((error) => {
        if (options.silent) return;
        setState((current) => ({
          state: "failed",
          sessions: current.sessions,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") loadSessions({ silent: true });
    };
    const interval = window.setInterval(refreshIfVisible, 8_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [loadSessions]);

  // The server record is the truth; the persisted deck is a cache of it, so a
  // workspace authored on one device opens on another. A server that has never
  // been written to leaves the local deck alone rather than wiping it.
  useEffect(() => {
    let cancelled = false;
    void fetchTerminalWorkspaces()
      .then((payload) => {
        if (cancelled) return;
        setWorkspaceResolutions(payload.resolutions);
        for (const record of payload.workspaces) {
          syncedWorkspacesRef.current.set(
            record.id,
            JSON.stringify(terminalWorkspaceRecordInputFromLayout(
              terminalWorkspaceLayoutFromRecord(record),
              { sessions: state.sessions },
            )),
          );
        }
        if (payload.workspaces.length === 0) return;
        setDeck((current) => {
          let next = current;
          for (const record of payload.workspaces) {
            next = upsertTerminalWorkspace(next, terminalWorkspaceLayoutFromRecord(record));
          }
          // upsert activates whatever it wrote last; keep the operator where
          // they were.
          return { ...next, activeWorkspaceId: current.activeWorkspaceId || next.activeWorkspaceId };
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Deliberately mount-only: this seeds the deck from the server, and
    // re-running it on every session refresh would fight the operator's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDeck]);

  const terminalItems = useMemo(() => terminalListItems(state.sessions), [state.sessions]);
  const liveTerminalItems = useMemo(
    () => terminalItems.filter((item) => item.surface.state !== "exited"),
    [terminalItems],
  );
  const { managed: multiplexerItems } = useMemo(
    () => partitionTerminalListItems(liveTerminalItems),
    [liveTerminalItems],
  );
  const engagedSessionItems = useMemo(
    () => liveTerminalItems.filter((item) => item.origin === "scout"),
    [liveTerminalItems],
  );
  const terminalAgents = useMemo(
    () => sortTerminalAgents(agents).filter((agent) => Boolean(resolveAgentTerminalSurface(agent))),
    [agents],
  );
  const selectedMultiplexer = multiplexerItems.find((item) => item.id === selectedMultiplexerId)
    ?? multiplexerItems[0]
    ?? null;

  useEffect(() => {
    if (selectedMultiplexer?.id !== selectedMultiplexerId) {
      setSelectedMultiplexerId(selectedMultiplexer?.id ?? null);
    }
  }, [selectedMultiplexer?.id, selectedMultiplexerId]);
  const pickerAttachableItems = useMemo(() => {
    if (pickerSource === "multiplexer") return multiplexerItems;
    if (pickerSource === "session") return engagedSessionItems;
    const represented = new Set<string>();
    return terminalAgents.flatMap((agent) => {
      const item = liveTerminalItems.find((candidate) => findTerminalItemAgent(candidate, [agent])?.id === agent.id);
      if (!item || represented.has(item.id)) return [];
      represented.add(item.id);
      return [item];
    });
  }, [engagedSessionItems, liveTerminalItems, multiplexerItems, pickerSource, terminalAgents]);
  const sessionError = state.state === "failed" ? state.error : null;
  const workspaceDefinitions = deck.workspaces;
  const activeWorkspace = deck.workspaces.find((workspace) => workspace.id === deck.activeWorkspaceId) ?? null;
  const workspaceLayout = terminalWorkspaceLayoutOf({
    layout: activeWorkspace?.layout,
    columns: activeWorkspace?.columns,
    cellCount: activeWorkspace?.tiles.length ?? 0,
  });
  // The deck is the truth; tiles are a projection of the active workspace's
  // cells over the live session list. Nothing has to be copied back.
  const tiles = useMemo(
    () => (activeWorkspace?.tiles ?? []).map((cell) =>
      terminalTileFromCell(cell, state.sessions, activeWorkspace?.id ?? "")
    ),
    [activeWorkspace?.id, activeWorkspace?.tiles, state.sessions],
  );
  const gridColumns = resolveTerminalWorkspaceColumns(workspaceLayout, { tileCount: tiles.length });

  // Changing the layout or the tiles of a workspace that Scout already stores
  // writes through. Only the builder's Save used to, so every change made after
  // authoring — reflowing to lanes, adding a tile, reordering — lived in one
  // browser's localStorage and was gone on the next device. A workspace that
  // has never been saved stays local, so the "not saved to Scout" banner keeps
  // meaning what it says.
  useEffect(() => {
    if (!activeWorkspace) return;
    if (!syncedWorkspacesRef.current.has(activeWorkspace.id)) return;
    const input = terminalWorkspaceRecordInputFromLayout(activeWorkspace, { sessions: state.sessions });
    const signature = JSON.stringify(input);
    if (syncedWorkspacesRef.current.get(activeWorkspace.id) === signature) return;
    syncedWorkspacesRef.current.set(activeWorkspace.id, signature);
    void saveTerminalWorkspace(input)
      .catch((error) => setWorkspaceSyncError(error instanceof Error ? error.message : String(error)));
  }, [activeWorkspace, state.sessions]);
  const workspaceView: TerminalWorkspaceView = storedWorkspaceView === "workspace" && !activeWorkspace
    ? "library"
    : storedWorkspaceView;

  const updateActiveCells = useCallback((
    update: (cells: TerminalWorkspaceCellDefinition[]) => TerminalWorkspaceCellDefinition[],
  ) => {
    setDeck((current) => {
      const workspace = current.workspaces.find((candidate) => candidate.id === current.activeWorkspaceId);
      if (!workspace) return current;
      const nextCells = update(workspace.tiles);
      if (nextCells === workspace.tiles) return current;
      return updateTerminalWorkspace(current, workspace.id, { tiles: nextCells, updatedAt: Date.now() });
    });
  }, [setDeck]);

  const setWorkspaceLayout = useCallback((layout: TerminalWorkspaceLayout) => {
    setDeck((current) => current.activeWorkspaceId
      ? updateTerminalWorkspace(current, current.activeWorkspaceId, { layout, updatedAt: Date.now() })
      : current);
  }, [setDeck]);

  const enterWorkspace = useCallback((workspace: TerminalWorkspaceDefinition) => {
    setDeck((current) => selectTerminalWorkspace(current, workspace.id));
    setPickerVisible(false);
    setWorkspaceView("workspace");
  }, [setDeck, setWorkspaceView]);

  const showWorkspaceLibrary = useCallback(() => {
    setWorkspaceView("library");
  }, [setWorkspaceView]);

  const startWorkspaceBuilder = useCallback((workspace?: TerminalWorkspaceDefinition) => {
    setEditingWorkspaceId(workspace?.id ?? null);
    setWorkspaceDraftName(workspace?.name ?? "");
    setWorkspaceDraftPurpose(workspace?.purpose ?? "");
    setWorkspaceDraftLayout(workspace
      ? terminalWorkspaceLayoutOf({
        layout: workspace.layout,
        columns: workspace.columns,
        cellCount: workspace.tiles.length,
      })
      : TERMINAL_DEFAULT_DRAFT_LAYOUT);
    setWorkspaceDraftCells(
      workspace?.tiles ?? Array.from({ length: 4 }, () => createFreshTerminalCell("pty")),
    );
    setWorkspaceDraftSlot(0);
    setWorkspaceView("builder");
  }, [setWorkspaceView]);

  /**
   * Picking a mode sets the shape and grows a thin draft to the smallest count
   * where that shape means anything — a grid of one tile is a solo. It never
   * drops cells the operator already placed; removing one is an explicit act.
   */
  const applyWorkspaceDraftMode = useCallback((option: TerminalLayoutModeOption) => {
    setWorkspaceDraftLayout((current) => option.mode === "solo"
      ? { mode: "solo" }
      : { mode: option.mode, columns: current.columns ?? "dynamic" });
    setWorkspaceDraftCells((current) => current.length >= option.minimumCells
      ? current
      : [
        ...current,
        ...Array.from({ length: option.minimumCells - current.length }, () => createFreshTerminalCell("pty")),
      ]);
    setWorkspaceDraftSlot((slot) => Math.max(0, Math.min(slot, option.minimumCells - 1)));
  }, []);

  const setWorkspaceDraftColumns = useCallback((columns: TerminalWorkspaceColumnCount) => {
    setWorkspaceDraftLayout((current) => current.mode === "solo"
      ? { mode: "lanes", columns }
      : { ...current, columns });
  }, []);

  const addWorkspaceDraftCell = useCallback(() => {
    setWorkspaceDraftCells((current) => {
      const next = [...current, createFreshTerminalCell("pty")];
      setWorkspaceDraftSlot(next.length - 1);
      return next;
    });
  }, []);

  const removeWorkspaceDraftCell = useCallback((index: number) => {
    setWorkspaceDraftCells((current) => {
      if (current.length <= 1) return current;
      const next = current.filter((_, candidate) => candidate !== index);
      setWorkspaceDraftSlot((slot) => Math.min(slot, next.length - 1));
      return next;
    });
  }, []);

  const saveWorkspaceDraft = useCallback(() => {
    const name = workspaceDraftName.trim();
    if (!name) return;
    const definition: TerminalWorkspaceDefinition = {
      id: editingWorkspaceId ?? createTerminalDeckId("workspace"),
      name,
      purpose: workspaceDraftPurpose.trim(),
      columns: resolveTerminalWorkspaceColumns(workspaceDraftLayout, { tileCount: workspaceDraftCells.length }),
      layout: workspaceDraftLayout,
      tiles: workspaceDraftCells,
      updatedAt: Date.now(),
    };
    setDeck((current) => upsertTerminalWorkspace(current, definition));
    // Write through to the server record. Local state is not rolled back on
    // failure — the deck keeps working offline — but the failure is not
    // swallowed silently either.
    // The live session list rides along so registered cells can save the
    // directory and resume command their registry record knows. That detail is
    // what makes such a cell revivable after the host restarts instead of
    // "saved without enough detail to reopen it".
    const input = terminalWorkspaceRecordInputFromLayout(definition, { sessions: state.sessions });
    syncedWorkspacesRef.current.set(definition.id, JSON.stringify(input));
    void saveTerminalWorkspace(input)
      .catch((error) => setWorkspaceSyncError(error instanceof Error ? error.message : String(error)));
    setPickerVisible(false);
    setWorkspaceView("workspace");
  }, [editingWorkspaceId, setDeck, setWorkspaceView, state.sessions, workspaceDraftCells, workspaceDraftLayout, workspaceDraftName, workspaceDraftPurpose]);

  const deleteWorkspace = useCallback((workspaceId: string) => {
    setDeck((current) => closeTerminalWorkspace(current, workspaceId, { allowEmpty: true }));
    void removeTerminalWorkspace(workspaceId).catch(() => {});
  }, [setDeck]);

  const addFreshTile = useCallback((backend: TerminalCellBackend, agent: TerminalAgentKind = "shell") => {
    updateActiveCells((cells) => [...cells, createFreshTerminalCell(backend, agent)]);
  }, [updateActiveCells]);

  const placeRegisteredTarget = useCallback((target: RegisteredTerminalTarget, destinationTileId?: string) => {
    const cell = {
      kind: "registered" as const,
      terminalSessionId: target.session.id,
      terminalSurfaceKey: surfaceKey(target.surface),
    };
    updateActiveCells((cells) => {
      const alreadyPlaced = cells.some((candidate) =>
        candidate.kind === "registered"
        && candidate.terminalSessionId === cell.terminalSessionId
        && terminalSurfaceIdsEqual(candidate.terminalSurfaceKey, cell.terminalSurfaceKey)
      );
      if (!destinationTileId) {
        return alreadyPlaced ? cells : [...cells, { ...cell, id: createTerminalDeckId("cell") }];
      }
      return cells.some((candidate) => candidate.id === destinationTileId)
        ? cells.map((candidate) => candidate.id === destinationTileId ? { ...cell, id: candidate.id } : candidate)
        : cells;
    });
  }, [updateActiveCells]);

  const attachRegisteredTarget = useCallback((target: RegisteredTerminalTarget) => {
    placeRegisteredTarget(target);
  }, [placeRegisteredTarget]);

  const attachedTargetIds = useMemo(
    () => new Set(
      tiles
        .filter((tile): tile is RegisteredTerminalTileModel => tile.kind === "registered")
        .map((tile) => registeredTerminalTargetKey(tile.target)),
    ),
    [tiles],
  );

  const clearPickerDrag = useCallback((event?: ReactPointerEvent<HTMLElement>) => {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pickerDragRef.current = null;
    pickerDropTileIdRef.current = null;
    pickerDropNewSlotRef.current = false;
    setPickerDraggedTargetId(null);
    setPickerDropTileId(null);
    setPickerDropNewSlot(false);
  }, []);

  const startPickerDrag = useCallback((event: ReactPointerEvent<HTMLElement>, item: TerminalHomeListItem) => {
    const target = event.target;
    if (event.button !== 0 || (target instanceof Element && target.closest("button, a"))) return;
    pickerDragRef.current = {
      pointerId: event.pointerId,
      target: registeredTargetFromListItem(item),
      targetId: registeredTerminalTargetKey(registeredTargetFromListItem(item)),
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const updatePickerDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = pickerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (distance < 6 && !pickerDraggedTargetId) return;
    if (!pickerDraggedTargetId) setPickerDraggedTargetId(drag.targetId);
    const workspace = document.querySelector<HTMLElement>(".s-term--workspace");
    if (workspace) {
      const workspaceRect = workspace.getBoundingClientRect();
      if (event.clientY < workspaceRect.top + 72) workspace.scrollTop -= 28;
      if (event.clientY > workspaceRect.bottom - 72) workspace.scrollTop += 28;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const cell = element?.closest<HTMLElement>(".s-term-workspace-cell");
    const isNewSlot = Boolean(
      element?.closest(".s-term-workspace-add-cell")
      || (!cell && element?.closest(".s-term--workspace") && !element?.closest(".s-term-picker")),
    );
    const nextTileId = isNewSlot ? null : cell?.dataset.terminalTileId ?? null;
    pickerDropTileIdRef.current = nextTileId;
    pickerDropNewSlotRef.current = isNewSlot;
    setPickerDropTileId(nextTileId);
    setPickerDropNewSlot(isNewSlot);
  }, [pickerDraggedTargetId]);

  const finishPickerDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = pickerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (pickerDropNewSlotRef.current) {
      placeRegisteredTarget(drag.target);
    } else if (pickerDropTileIdRef.current) {
      placeRegisteredTarget(drag.target, pickerDropTileIdRef.current);
    }
    clearPickerDrag(event);
  }, [clearPickerDrag, placeRegisteredTarget]);

  const cancelPickerDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    clearPickerDrag(event);
  }, [clearPickerDrag]);

  const attachAllPickerTargets = useCallback(() => {
    const targets = pickerAttachableItems.map(registeredTargetFromListItem);
    if (targets.length === 0) return;
    updateActiveCells((cells) => {
      const placed = cells.filter((cell) => cell.kind === "registered");
      const additions = targets
        .filter((target) => !placed.some((cell) =>
          cell.kind === "registered"
          && cell.terminalSessionId === target.session.id
          && terminalSurfaceIdsEqual(cell.terminalSurfaceKey, surfaceKey(target.surface))
        ))
        .map((target) => ({
          id: createTerminalDeckId("cell"),
          kind: "registered" as const,
          terminalSessionId: target.session.id,
          terminalSurfaceKey: surfaceKey(target.surface),
        }));
      return additions.length === 0 ? cells : [...cells, ...additions];
    });
  }, [pickerAttachableItems, updateActiveCells]);

  const closeTile = useCallback((tileId: string) => {
    updateActiveCells((cells) => {
      const next = cells.filter((cell) => cell.id !== tileId);
      return next.length === cells.length ? cells : next;
    });
  }, [updateActiveCells]);

  const reorderTile = useCallback((
    sourceTileId: string,
    destinationTileId: string,
    edge: "before" | "after",
  ) => {
    if (sourceTileId === destinationTileId) return;
    updateActiveCells((cells) => moveTerminalWorkspaceItem(cells, sourceTileId, destinationTileId, edge));
  }, [updateActiveCells]);

  const moveTile = useCallback((tileId: string, offset: -1 | 1) => {
    updateActiveCells((cells) => {
      const currentIndex = cells.findIndex((cell) => cell.id === tileId);
      const nextIndex = currentIndex + offset;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= cells.length) return cells;
      const next = [...cells];
      [next[currentIndex], next[nextIndex]] = [next[nextIndex]!, next[currentIndex]!];
      return next;
    });
  }, [updateActiveCells]);

  const replaceTile = useCallback((tileId: string, backend: TerminalCellBackend) => {
    updateActiveCells((cells) => cells.map((cell) => cell.id === tileId
      // Keeping the cell id keeps the slot; the session name follows the
      // backend, so a replaced tmux tile does not squat the zellij name.
      ? { id: cell.id, kind: "fresh" as const, backend, agent: "shell" as const }
      : cell));
  }, [updateActiveCells]);

  const gridMenuItems = useCallback((): MenuItem[] => [
    ...TERMINAL_LAYOUT_MODES.map((option): MenuItem => ({
      kind: "action",
      label: option.label,
      onSelect: () => setWorkspaceLayout(option.mode === "solo"
        ? { mode: "solo" }
        : { mode: option.mode, columns: workspaceLayout.columns ?? "dynamic" }),
    })),
    ...(workspaceLayout.mode === "solo" ? [] : [
      { kind: "separator" } as MenuItem,
      {
        kind: "action",
        label: "Dynamic columns",
        onSelect: () => setWorkspaceLayout({ ...workspaceLayout, columns: "dynamic" }),
      } as MenuItem,
      ...Array.from({ length: TERMINAL_WORKSPACE_MAX_COLUMNS }, (_, index): MenuItem => ({
        kind: "action",
        label: index === 0 ? "One column" : `${index + 1} columns`,
        onSelect: () => setWorkspaceLayout({ ...workspaceLayout, columns: index + 1 }),
      })),
    ]),
    { kind: "separator" },
    {
      kind: "action",
      label: "Edit workspace…",
      onSelect: () => activeWorkspace && startWorkspaceBuilder(activeWorkspace),
    },
  ], [activeWorkspace, setWorkspaceLayout, startWorkspaceBuilder, workspaceLayout]);

  const showGridMenu = useCallback((event: ReactMouseEvent) => {
    showContextMenu(event, gridMenuItems());
  }, [gridMenuItems, showContextMenu]);

  const showNewTerminalMenu = useCallback((event: ReactMouseEvent) => {
    showContextMenu(event, TERMINAL_FRESH_AGENT_OPTIONS.map((option): MenuItem => ({
      kind: "action",
      label: option.value === "shell" ? "New shell" : `New ${option.label} terminal`,
      onSelect: () => addFreshTile("pty", option.value),
    })));
  }, [addFreshTile, showContextMenu]);

  const showTileMenu = useCallback((event: ReactMouseEvent, tile: TerminalWorkspaceTileModel) => {
    const tileIndex = tiles.findIndex((candidate) => candidate.id === tile.id);
    const items: MenuItem[] = [];
    if (tileIndex > 0) {
      items.push({ kind: "action", label: "Move left", onSelect: () => moveTile(tile.id, -1) });
    }
    if (tileIndex >= 0 && tileIndex < tiles.length - 1) {
      items.push({ kind: "action", label: "Move right", onSelect: () => moveTile(tile.id, 1) });
    }
    if (items.length > 0) items.push({ kind: "separator" });
    items.push(
      // Described by the property that matters, not by which renderer runs it.
      ...startOptions.map((option): MenuItem => ({
        kind: "action",
        label: option.value === "pty"
          ? "Replace with a disposable shell"
          : `Replace with a session that survives (${option.label})`,
        onSelect: () => replaceTile(tile.id, option.value as TerminalCellBackend),
      })),
      { kind: "separator" },
      { kind: "action", label: "Remove cell", onSelect: () => closeTile(tile.id) },
      { kind: "separator" },
      ...gridMenuItems(),
    );
    showContextMenu(event, items);
  }, [closeTile, gridMenuItems, moveTile, replaceTile, showContextMenu, startOptions, tiles]);

  const startTileDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, tileId: string) => {
    const target = event.target;
    const isDragHandle = event.button === 0
      && target instanceof Element
      && Boolean(target.closest(".s-term-bar, .s-term-float-grip"))
      && !target.closest("button, a");
    if (!isDragHandle) return;
    tileDragRef.current = {
      pointerId: event.pointerId,
      tileId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const updateTileDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = tileDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (distance < 6 && !draggedTileId) return;
    if (!draggedTileId) setDraggedTileId(drag.tileId);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".s-term-workspace-cell");
    const targetTileId = target?.dataset.terminalTileId ?? null;
    if (!target || !targetTileId || targetTileId === drag.tileId) {
      dropTargetTileIdRef.current = null;
      dropTargetEdgeRef.current = "after";
      setDropTargetTileId(null);
      return;
    }
    const bounds = target.getBoundingClientRect();
    const placement = terminalWorkspaceDropPlacement(
      { x: event.clientX, y: event.clientY },
      { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      gridColumns,
    );
    dropTargetTileIdRef.current = targetTileId;
    dropTargetEdgeRef.current = placement.edge;
    setDropTargetTileId(targetTileId);
  }, [draggedTileId, gridColumns]);

  const finishTileDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = tileDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const targetTileId = dropTargetTileIdRef.current;
    if (targetTileId) reorderTile(drag.tileId, targetTileId, dropTargetEdgeRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    tileDragRef.current = null;
    dropTargetTileIdRef.current = null;
    dropTargetEdgeRef.current = "after";
    setDraggedTileId(null);
    setDropTargetTileId(null);
  }, [reorderTile]);

  const activeCellStatuses = useMemo(
    () => terminalWorkspaceCellStatuses(
      workspaceResolutions.find((candidate) => candidate.workspaceId === activeWorkspace?.id),
    ),
    [activeWorkspace?.id, workspaceResolutions],
  );

  const sortPickerBy = useCallback((column: TerminalSessionColumn) => {
    setPickerSort((current) => toggleTerminalSessionSort(current, column));
  }, []);

  const handlePickerSourceKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    source: TerminalPickerSource,
  ) => {
    const nextSource = nextTerminalPickerSource(source, event.key);
    if (!nextSource) return;
    event.preventDefault();
    setPickerSource(nextSource);
    document.getElementById(terminalPickerTabId(nextSource))?.focus();
  }, [setPickerSource]);

  const reloadWorkspace = useCallback(() => {
    loadSessions();
    setWorkspaceReload((current) => current + 1);
  }, [loadSessions]);

  const reviveCell = useCallback((cellId: string) => {
    if (!activeWorkspace) return;
    void reviveTerminalWorkspaceCell(activeWorkspace.id, cellId)
      .then(() => {
        setWorkspaceSyncError(null);
        loadSessions();
      })
      .catch((error) => setWorkspaceSyncError(error instanceof Error ? error.message : String(error)));
  }, [activeWorkspace, loadSessions]);

  const cancelWorkspaceBuilder = useCallback(() => {
    setWorkspaceView(activeWorkspace ? "workspace" : "library");
  }, [activeWorkspace, setWorkspaceView]);

  const terminalHeader = (
    <TerminalHeaderMount>
      <div className="s-term-topline" aria-label="Terminal workspace controls">
        <div className="s-term-topline-context">
          <strong>
            {workspaceView === "builder"
              ? (editingWorkspaceId ? "Edit workspace" : "New workspace")
              : workspaceView === "library"
                ? "Workspaces"
                : activeWorkspace?.name ?? "Workspace"}
          </strong>
          <span>
            {workspaceDefinitions.length} workspace{workspaceDefinitions.length === 1 ? "" : "s"}
            <i aria-hidden="true">·</i>
            {liveTerminalItems.length} terminal{liveTerminalItems.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="s-term-topline-actions">
          <a
            className="s-term-topline-button"
            href="scout://terminal"
            title="Open this terminal workspace in the Scout app"
          >
            <ExternalLink size={13} strokeWidth={1.8} />
            <span>Open in Scout</span>
          </a>
          {workspaceView === "library" ? (
            <button type="button" className="s-term-topline-button is-primary" onClick={() => startWorkspaceBuilder()}>
              <Plus size={13} strokeWidth={1.9} />
              <span>New workspace</span>
            </button>
          ) : workspaceView === "builder" ? (
            <>
              <button type="button" className="s-term-topline-button" onClick={cancelWorkspaceBuilder}>Cancel</button>
              <button
                type="button"
                className="s-term-topline-button is-primary"
                onClick={saveWorkspaceDraft}
                disabled={!workspaceDraftName.trim()}
              >
                {editingWorkspaceId ? "Save" : "Create"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="s-term-topline-button" onClick={showWorkspaceLibrary}>
                Workspaces
              </button>
              <button type="button" className="s-term-topline-button is-primary" onClick={showNewTerminalMenu}>
                <Plus size={13} strokeWidth={1.9} />
                <span>New</span>
              </button>
              <button
                type="button"
                className="s-term-topline-button"
                onClick={() => setPickerVisible((current) => !current)}
                aria-pressed={pickerVisible}
              >
                <TerminalIcon size={13} strokeWidth={1.8} />
                <span>{pickerVisible ? "Hide picker" : "Show picker"}</span>
              </button>
              <button type="button" className="s-term-topline-icon" onClick={showGridMenu} title="Workspace layout and settings" aria-label="Workspace layout and settings">
                <MoreHorizontal size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="s-term-topline-icon"
                onClick={reloadWorkspace}
                disabled={state.state === "loading"}
                title="Reload terminal inventory and previews"
                aria-label="Reload terminal inventory and previews"
              >
                <RefreshCw size={13} strokeWidth={1.8} />
              </button>
            </>
          )}
        </div>
      </div>
    </TerminalHeaderMount>
  );

  if (workspaceView === "library") {
    return (
      <TerminalWorkspaceLibrary
        header={terminalHeader}
        workspaces={workspaceDefinitions}
        sessionsReady={state.state !== "loading"}
        onOpen={enterWorkspace}
        onCreate={() => startWorkspaceBuilder()}
        onEdit={startWorkspaceBuilder}
        onDelete={deleteWorkspace}
      />
    );
  }

  if (workspaceView === "builder") {
    return (
      <TerminalWorkspaceBuilder
        header={terminalHeader}
        editing={Boolean(editingWorkspaceId)}
        name={workspaceDraftName}
        purpose={workspaceDraftPurpose}
        modes={TERMINAL_LAYOUT_MODES}
        layout={workspaceDraftLayout}
        startOptions={startOptions}
        cells={workspaceDraftCells}
        selectedSlot={workspaceDraftSlot}
        terminalItems={liveTerminalItems}
        onNameChange={setWorkspaceDraftName}
        onPurposeChange={setWorkspaceDraftPurpose}
        onApplyMode={applyWorkspaceDraftMode}
        onColumnsChange={setWorkspaceDraftColumns}
        onSelectSlot={setWorkspaceDraftSlot}
        onAddCell={addWorkspaceDraftCell}
        onRemoveCell={removeWorkspaceDraftCell}
        pickerView={pickerView}
        pickerSort={pickerSort}
        onPickerView={setPickerView}
        onPickerSort={sortPickerBy}
        onAssignFresh={(backend, agent = "shell") => setWorkspaceDraftCells((current) => current.map((cell, index) =>
          index === workspaceDraftSlot ? { id: cell.id, kind: "fresh", backend, agent } : cell
        ))}
        onAssignRegistered={(item) => setWorkspaceDraftCells((current) => current.map((cell, index) =>
          index === workspaceDraftSlot
            ? {
                id: cell.id,
                kind: "registered",
                terminalSessionId: item.session.id,
                terminalSurfaceKey: surfaceKey(item.surface),
              }
            : cell
        ))}
      />
    );
  }

  return (
    <div className="s-term s-term--workspace">
      {terminalHeader}
      <div className="s-term-workspace">
        <h1 className="s-term-visually-hidden">{activeWorkspace?.name ?? "Terminal workspace"}</h1>

        {sessionError && (
          <div className="s-term-home-error">
            <span>Terminal registry unavailable</span>
            <code>{sessionError}</code>
          </div>
        )}

        {workspaceSyncError && (
          <div className="s-term-home-error">
            <span>This workspace is not saved to Scout — it will not follow you to another device</span>
            <code>{workspaceSyncError}</code>
          </div>
        )}

        {(tiles.length > 0 || pickerVisible) && (
          <div
            className="s-term-workspace-grid"
            aria-label="Terminal tiles"
            style={{ "--terminal-grid-columns": gridColumns } as CSSProperties}
            onContextMenu={showGridMenu}
          >
            {tiles.map((tile) => (
              <div
                key={`${tile.id}:${workspaceReload}`}
                className={`s-term-workspace-cell${draggedTileId === tile.id ? " s-term-workspace-cell--dragging" : ""}${dropTargetTileId === tile.id || pickerDropTileId === tile.id ? " s-term-workspace-cell--drop-target" : ""}`}
                data-terminal-tile-id={tile.id}
                onPointerDownCapture={(event) => startTileDrag(event, tile.id)}
                onPointerMove={updateTileDrag}
                onPointerUp={finishTileDrag}
                onPointerCancel={finishTileDrag}
                onContextMenu={(event) => showTileMenu(event, tile)}
              >
                <TerminalWorkspaceTile
                  tile={tile}
                  navigate={navigate}
                  onClose={closeTile}
                  resolution={activeCellStatuses.get(tile.id) ?? null}
                  onRevive={reviveCell}
                  live={isTileSessionLive(tile, state.sessions)}
                />
              </div>
            ))}
            {pickerVisible && (
              <button
                type="button"
                className={`s-term-workspace-add-cell${pickerDropNewSlot ? " s-term-workspace-add-cell--target" : ""}`}
                onClick={() => setPickerVisible(true)}
              >
                <Plus size={20} strokeWidth={1.7} />
                <strong>New slot</strong>
                <span>{pickerDraggedTargetId ? "Drop to add" : "Drag a terminal here"}</span>
              </button>
            )}
          </div>
        )}

        <section
          className={`s-term-picker${pickerVisible ? "" : " s-term-picker--collapsed"}`}
          aria-labelledby="terminal-picker-title"
          onPointerDownCapture={(event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const itemId = target.closest<HTMLElement>("[data-picker-item-id]")?.dataset.pickerItemId;
            const item = liveTerminalItems.find((candidate) => candidate.id === itemId);
            if (item) startPickerDrag(event, item);
          }}
          onPointerMove={updatePickerDrag}
          onPointerUp={finishPickerDrag}
          onPointerCancel={cancelPickerDrag}
        >
          <header className="s-term-picker-head">
            <div className="s-term-picker-title">
              <TerminalIcon size={14} strokeWidth={1.8} />
              <h2 id="terminal-picker-title">Add to workspace</h2>
            </div>
            <div className="s-term-picker-actions">
              {pickerVisible && pickerSource === "session" && (
                <div className="s-term-picker-views" role="group" aria-label="Picker view">
                  {(["list", "table"] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      className={pickerView === view ? "is-selected" : ""}
                      onClick={() => setPickerView(view)}
                      aria-pressed={pickerView === view}
                    >
                      {view === "list" ? "List" : "Table"}
                    </button>
                  ))}
                </div>
              )}
              {pickerVisible && (
                <button
                  type="button"
                  className="s-term-workspace-action"
                  onClick={attachAllPickerTargets}
                  disabled={pickerAttachableItems.length === 0}
                >
                  <LogIn size={13} strokeWidth={1.8} />
                  <span>Add all</span>
                </button>
              )}
              <button
                type="button"
                className="s-term-picker-toggle"
                onClick={() => setPickerVisible((current) => !current)}
                aria-expanded={pickerVisible}
              >
                <span>{pickerVisible ? "Hide" : "Show terminal picker"}</span>
                <span aria-hidden="true">{pickerVisible ? "⌄" : "⌃"}</span>
              </button>
            </div>
          </header>
          {pickerVisible && (
            <>
              <div className="s-term-picker-sources" role="tablist" aria-label="Ways to find a terminal">
                {([
                  {
                    source: "multiplexer",
                    label: "Multiplexer setups",
                    detail: "Multi-pane · Herdr, tmux, Zellij",
                    count: multiplexerItems.length,
                    icon: Grid2X2,
                  },
                  {
                    source: "agent",
                    label: "Agent sessions",
                    detail: "Agent-owned · managed terminals",
                    count: terminalAgents.length,
                    icon: Zap,
                  },
                  {
                    source: "session",
                    label: "Recent sessions",
                    detail: "Individual · previously opened by Scout",
                    count: engagedSessionItems.length,
                    icon: TerminalIcon,
                  },
                ] as const).map(({ source, label, detail, count, icon: SourceIcon }) => (
                  <button
                    key={source}
                    type="button"
                    role="tab"
                    id={terminalPickerTabId(source)}
                    aria-controls={terminalPickerPanelId()}
                    className={pickerSource === source ? "is-selected" : ""}
                    aria-selected={pickerSource === source}
                    tabIndex={pickerSource === source ? 0 : -1}
                    onClick={() => setPickerSource(source)}
                    onKeyDown={(event) => handlePickerSourceKeyDown(event, source)}
                  >
                    <SourceIcon size={16} strokeWidth={1.7} aria-hidden="true" />
                    <span>
                      <strong>{label}</strong>
                      <small>{detail}</small>
                    </span>
                    <em aria-label={`${state.state === "loading" ? "Loading" : count} ${label.toLowerCase()}`}>
                      {state.state === "loading" ? "·" : count}
                    </em>
                  </button>
                ))}
              </div>
              <div
                className="s-term-picker-panel"
                role="tabpanel"
                id={terminalPickerPanelId()}
                aria-labelledby={terminalPickerTabId(pickerSource)}
              >
                <p className="s-term-picker-hint">
                  {pickerSource === "multiplexer"
                    ? "Preview a complete multiplexer setup, then open it or add the host-owned layout to this workspace."
                    : pickerSource === "agent"
                      ? "Start from ownership: open the terminal associated with a managed agent, or add that surface here."
                      : "Return to individual terminal sessions Scout has already opened or registered."}
                </p>
                {pickerSource === "multiplexer" ? (
                  <TerminalMultiplexerPicker
                    items={multiplexerItems}
                    selectedId={selectedMultiplexer?.id ?? null}
                    attachedIds={attachedTargetIds}
                    draggedTargetId={pickerDraggedTargetId}
                    onSelect={setSelectedMultiplexerId}
                    onAttach={attachRegisteredTarget}
                    navigate={navigate}
                  />
                ) : pickerSource === "agent" ? (
                  <TerminalAgentPicker
                    agents={terminalAgents}
                    items={liveTerminalItems}
                    attachedIds={attachedTargetIds}
                    onAttach={attachRegisteredTarget}
                    navigate={navigate}
                  />
                ) : engagedSessionItems.length === 0 && state.state !== "loading" ? (
                  <div className="s-term-picker-empty s-term-picker-empty--explained">
                    <strong>No recent sessions yet</strong>
                    <span>Open or register a terminal session and it will appear here.</span>
                  </div>
                ) : (
                  <TerminalSessionPicker
                    items={engagedSessionItems}
                    view={pickerView}
                    sort={pickerSort}
                    attachedIds={attachedTargetIds}
                    draggedTargetId={pickerDraggedTargetId}
                    onSort={sortPickerBy}
                    onAttach={attachRegisteredTarget}
                    navigate={navigate}
                    groupManaged={false}
                  />
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function TerminalWorkspaceLibrary({
  header,
  workspaces,
  sessionsReady,
  onOpen,
  onCreate,
  onEdit,
  onDelete,
}: {
  header: ReactNode;
  workspaces: TerminalWorkspaceDefinition[];
  sessionsReady: boolean;
  onOpen: (workspace: TerminalWorkspaceDefinition) => void;
  onCreate: () => void;
  onEdit: (workspace: TerminalWorkspaceDefinition) => void;
  onDelete: (workspaceId: string) => void;
}) {
  return (
    <div className="s-term s-term--workspace-library">
      {header}
      <main className="s-term-workspace-library">
        <h1 className="s-term-visually-hidden">Terminal workspaces</h1>

        {workspaces.length === 0 ? (
          <section className="s-term-workspace-library-empty">
            <Grid2X2 size={24} strokeWidth={1.5} />
            <h2>Create your first terminal workspace</h2>
            <p>Choose a layout, give it a purpose, place sessions, then enter the grid.</p>
            <button type="button" className="s-term-workspace-action s-term-workspace-action--primary" onClick={onCreate}>
              <Plus size={14} strokeWidth={1.9} />
              <span>Create workspace</span>
            </button>
          </section>
        ) : (
          <div className="s-term-workspace-library-grid">
            {workspaces.map((workspace) => (
              <article className="s-term-workspace-card" key={workspace.id}>
                <div className="s-term-workspace-card-preview" style={{ "--terminal-grid-columns": workspace.columns ?? TERMINAL_DEFAULT_GRID_COLUMNS } as CSSProperties}>
                  {workspace.tiles.map((cell) => (
                    <span key={cell.id} className={cell.kind === "registered" ? "is-session" : "is-shell"} />
                  ))}
                </div>
                <div className="s-term-workspace-card-copy">
                  <span>{workspace.columns ?? TERMINAL_DEFAULT_GRID_COLUMNS} column{(workspace.columns ?? TERMINAL_DEFAULT_GRID_COLUMNS) === 1 ? "" : "s"} · {workspace.tiles.length} cells</span>
                  <h2>{workspace.name}</h2>
                  <p>{workspace.purpose || "No purpose added yet."}</p>
                </div>
                <div className="s-term-workspace-card-actions">
                  <button type="button" className="s-term-workspace-action" onClick={() => onEdit(workspace)}>Edit</button>
                  <button type="button" className="s-term-workspace-action" onClick={() => onDelete(workspace.id)}>Delete</button>
                  <button
                    type="button"
                    className="s-term-workspace-action s-term-workspace-action--primary"
                    onClick={() => onOpen(workspace)}
                    disabled={!sessionsReady}
                  >
                    Enter workspace
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

/** Little tile map on a mode button: shape only, not the real tile count. */
function layoutModePreviewColumns(mode: TerminalWorkspaceLayoutMode, columns: number): number {
  if (mode === "solo") return 1;
  if (mode === "lanes") return Math.max(2, Math.min(4, columns));
  return Math.max(2, Math.min(3, columns));
}

function layoutModePreviewCells(mode: TerminalWorkspaceLayoutMode, columns: number): number {
  if (mode === "solo") return 1;
  if (mode === "lanes") return layoutModePreviewColumns(mode, columns);
  return layoutModePreviewColumns(mode, columns) * 2;
}

function TerminalWorkspaceBuilder({
  header,
  editing,
  name,
  purpose,
  modes,
  layout,
  startOptions,
  cells,
  selectedSlot,
  terminalItems,
  onNameChange,
  onPurposeChange,
  onApplyMode,
  onColumnsChange,
  onSelectSlot,
  onAddCell,
  onRemoveCell,
  pickerView,
  pickerSort,
  onPickerView,
  onPickerSort,
  onAssignFresh,
  onAssignRegistered,
}: {
  header: ReactNode;
  editing: boolean;
  name: string;
  purpose: string;
  modes: readonly TerminalLayoutModeOption[];
  layout: TerminalWorkspaceLayout;
  startOptions: readonly TerminalStartOption[];
  cells: TerminalWorkspaceCellDefinition[];
  selectedSlot: number;
  terminalItems: TerminalHomeListItem[];
  onNameChange: (value: string) => void;
  onPurposeChange: (value: string) => void;
  onApplyMode: (option: TerminalLayoutModeOption) => void;
  onColumnsChange: (columns: TerminalWorkspaceColumnCount) => void;
  onSelectSlot: (slot: number) => void;
  onAddCell: () => void;
  onRemoveCell: (index: number) => void;
  pickerView: TerminalPickerView;
  pickerSort: TerminalSessionSort;
  onPickerView: (view: TerminalPickerView) => void;
  onPickerSort: (column: TerminalSessionColumn) => void;
  onAssignFresh: (backend: TerminalCellBackend, agent?: TerminalAgentKind) => void;
  onAssignRegistered: (item: TerminalHomeListItem) => void;
}) {
  const previewColumns = resolveTerminalWorkspaceColumns(layout, { tileCount: cells.length });
  return (
    <div className="s-term s-term--workspace-builder">
      {header}
      <main className="s-term-workspace-builder">
        <h1 className="s-term-visually-hidden">{editing ? "Edit terminal workspace" : "Create terminal workspace"}</h1>

        <section className="s-term-workspace-builder-identity" aria-label="Workspace identity">
          <label>
            <span>Name</span>
            <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Release desk" autoFocus />
          </label>
          <label>
            <span>Purpose</span>
            <input value={purpose} onChange={(event) => onPurposeChange(event.target.value)} placeholder="Cross-project release monitoring" />
          </label>
        </section>

        <section className="s-term-workspace-builder-layout" aria-labelledby="workspace-layout-title">
          <div className="s-term-workspace-builder-section-head">
            <div>
              <span>Step 1</span>
              <h2 id="workspace-layout-title">Choose the layout</h2>
            </div>
            <p>{terminalWorkspaceLayoutLabel(layout)} · {cells.length} cell{cells.length === 1 ? "" : "s"}</p>
          </div>
          <div className="s-term-grid-presets" aria-label="Workspace layout">
            {modes.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={`s-term-grid-preset${option.mode === layout.mode ? " s-term-grid-preset--selected" : ""}`}
                onClick={() => onApplyMode(option)}
                aria-pressed={option.mode === layout.mode}
              >
                <span
                  className="s-term-grid-preset-map"
                  style={{ "--terminal-preset-columns": layoutModePreviewColumns(option.mode, previewColumns) } as CSSProperties}
                  aria-hidden="true"
                >
                  {Array.from(
                    { length: layoutModePreviewCells(option.mode, previewColumns) },
                    (_, index) => <i key={index} />,
                  )}
                </span>
                <span className="s-term-grid-preset-label">{option.label}</span>
                <span className="s-term-grid-preset-detail">{option.detail}</span>
              </button>
            ))}
          </div>
          {layout.mode !== "solo" && (
            <div className="s-term-workspace-builder-columns" role="group" aria-label="Columns">
              <span>Columns</span>
              <button
                type="button"
                className={layout.columns === "dynamic" || layout.columns === undefined ? "is-selected" : ""}
                onClick={() => onColumnsChange("dynamic")}
                aria-pressed={layout.columns === "dynamic" || layout.columns === undefined}
                title="Fit the columns to the number of tiles"
              >
                Dynamic
              </button>
              {Array.from({ length: TERMINAL_WORKSPACE_MAX_COLUMNS }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  className={layout.columns === index + 1 ? "is-selected" : ""}
                  onClick={() => onColumnsChange(index + 1)}
                  aria-pressed={layout.columns === index + 1}
                >
                  {index + 1}
                </button>
              ))}
              {(layout.columns === "dynamic" || layout.columns === undefined) && (
                <em>{previewColumns} right now</em>
              )}
            </div>
          )}
        </section>

        <section className="s-term-workspace-builder-placement" aria-labelledby="workspace-placement-title">
          <div className="s-term-workspace-builder-section-head">
            <div>
              <span>Step 2</span>
              <h2 id="workspace-placement-title">Place terminals</h2>
            </div>
            <p>Select a cell, then choose a session or shell. Add as many cells as the work needs.</p>
          </div>
          <div className="s-term-workspace-builder-canvas">
            <div className="s-term-workspace-builder-grid" style={{ "--terminal-grid-columns": previewColumns } as CSSProperties}>
              {cells.map((cell, index) => {
                const registeredItem = cell.kind === "registered"
                  ? terminalItems.find((item) => item.session.id === cell.terminalSessionId && terminalSurfaceIdsEqual(surfaceKey(item.surface), cell.terminalSurfaceKey))
                  : null;
                return (
                  <div
                    key={cell.id}
                    className={`s-term-workspace-builder-cell${selectedSlot === index ? " is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="s-term-workspace-builder-cell-select"
                      onClick={() => onSelectSlot(index)}
                      aria-pressed={selectedSlot === index}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <TerminalIcon size={17} strokeWidth={1.7} />
                      <strong>{cell.kind === "registered" ? registeredItem?.title ?? "Unavailable session" : freshTerminalLabel(cell.backend, cell.agent).title}</strong>
                      <small>{cell.kind === "registered" ? registeredItem?.cwdLabel || registeredItem?.detail : cell.backend}</small>
                    </button>
                    {cells.length > 1 && (
                      <button
                        type="button"
                        className="s-term-workspace-builder-cell-remove"
                        onClick={() => onRemoveCell(index)}
                        title="Remove this cell"
                        aria-label={`Remove cell ${index + 1}`}
                      >
                        <X size={13} strokeWidth={1.9} />
                      </button>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                className="s-term-workspace-builder-cell s-term-workspace-builder-cell--add"
                onClick={onAddCell}
              >
                <Plus size={18} strokeWidth={1.7} />
                <strong>Add cell</strong>
              </button>
            </div>
            <aside className="s-term-workspace-builder-source">
              <span>Cell {String(selectedSlot + 1).padStart(2, "0")}</span>
              <h3>Start something new</h3>
              <div className="s-term-workspace-builder-source-actions">
                {TERMINAL_FRESH_AGENT_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => onAssignFresh("pty", option.value)}
                  >
                    {option.label}
                  </button>
                ))}
                {startOptions.filter((option) => option.value !== "pty").map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => onAssignFresh(option.value as TerminalCellBackend, "shell")}
                    title={option.relayAttach
                      ? option.detail
                      : `${option.detail} — Scout starts it; open it in ${option.label} to use it`}
                  >
                    {option.label}
                    {!option.relayAttach && <sup aria-label="opens outside Scout"> ↗</sup>}
                  </button>
                ))}
              </div>
              <div className="s-term-workspace-builder-source-head">
                <h3>Or use a live session</h3>
                <div className="s-term-picker-views" role="group" aria-label="Session picker view">
                  {(["list", "table"] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      className={pickerView === view ? "is-selected" : ""}
                      onClick={() => onPickerView(view)}
                      aria-pressed={pickerView === view}
                    >
                      {view === "list" ? "List" : "Table"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="s-term-workspace-builder-sessions">
                {terminalItems.length === 0 ? (
                  <span className="s-term-workspace-builder-no-sessions">No live sessions</span>
                ) : (
                  <TerminalSessionPicker
                    items={terminalItems}
                    view={pickerView}
                    sort={pickerSort}
                    attachedIds={new Set()}
                    draggedTargetId={null}
                    onSort={onPickerSort}
                    onAttach={(target) => {
                      const match = terminalItems.find((candidate) =>
                        candidate.session.id === target.session.id
                        && candidate.surface.sessionName === target.surface.sessionName
                      );
                      if (match) onAssignRegistered(match);
                    }}
                  />
                )}
              </div>
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}

function TerminalPickerItem({
  item,
  attached,
  dragging,
  selected = false,
  onSelect,
  onAttach,
  onOpen,
}: {
  item: TerminalHomeListItem;
  attached: boolean;
  dragging: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onAttach: (target: RegisteredTerminalTarget) => void;
  onOpen?: () => void;
}) {
  const summary = (
    <>
      <span className="s-term-picker-grip" aria-hidden="true">⠿</span>
      <div className="s-term-picker-item-main">
        <strong title={item.surface.sessionName}>{item.title}</strong>
        <span title={item.session.cwd ?? item.detail}>{item.cwdLabel || item.detail}</span>
      </div>
      <div className="s-term-picker-item-meta">
        <span>{item.surface.backend}</span>
        <span>{terminalSessionStateLabel(item)}</span>
        <span title={item.session.cwd ?? undefined}>{item.project}</span>
      </div>
    </>
  );

  return (
    <article
      className={`s-term-picker-item${attached ? " s-term-picker-item--attached" : ""}${dragging ? " s-term-picker-item--dragging" : ""}${selected ? " s-term-picker-item--selected" : ""}${onSelect ? " s-term-picker-item--selectable" : ""}`}
      data-picker-item-id={item.id}
      role={onSelect ? "listitem" : undefined}
    >
      {onSelect ? (
        <button
          type="button"
          className="s-term-picker-item-summary s-term-picker-item-select"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {summary}
        </button>
      ) : (
        <div className="s-term-picker-item-summary">{summary}</div>
      )}
      {onOpen && (
        <button
          type="button"
          className="s-term-picker-add"
          onClick={onOpen}
        >
          Open
        </button>
      )}
      <button
        type="button"
        className="s-term-picker-add"
        onClick={() => onAttach(registeredTargetFromListItem(item))}
        disabled={attached}
      >
        {attached ? "In grid" : "Add"}
      </button>
    </article>
  );
}

function TerminalMultiplexerPicker({
  items,
  selectedId,
  attachedIds,
  draggedTargetId,
  onSelect,
  onAttach,
  navigate,
}: {
  items: TerminalHomeListItem[];
  selectedId: string | null;
  attachedIds: Set<string>;
  draggedTargetId: string | null;
  onSelect: (itemId: string) => void;
  onAttach: (target: RegisteredTerminalTarget) => void;
  navigate: TerminalNavigate;
}) {
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  if (!selected) return <div className="s-term-picker-empty">No multiplexers discovered</div>;
  const previewSurface = terminalSurfaceDescriptorFromRegisteredSurface(selected.surface);

  return (
    <div className="s-term-picker-explorer">
      <div className="s-term-picker-list s-term-picker-list--explorer" role="list" aria-label="Managed multiplexers">
        {items.map((item) => {
          const target = registeredTargetFromListItem(item);
          const targetId = registeredTerminalTargetKey(target);
          return (
            <TerminalPickerItem
              key={item.id}
              item={item}
              attached={attachedIds.has(targetId)}
              dragging={draggedTargetId === targetId}
              selected={item.id === selected.id}
              onSelect={() => onSelect(item.id)}
              onAttach={onAttach}
              onOpen={() => navigate({
                view: "terminal",
                terminalSessionId: item.session.id,
                terminalSurfaceKey: surfaceKey(item.surface),
              })}
            />
          );
        })}
      </div>
      <section className="s-term-picker-preview" aria-label={`${selected.title} live preview`}>
        <div className="s-term-picker-preview-title">
          <div>
            <strong>{selected.title}</strong>
            <span>{selected.surface.backend} · {selected.project} · {terminalSessionStateLabel(selected)}</span>
          </div>
          <span>{terminalItemRunningDetail(selected, findTerminalItemAgent(selected, []))}</span>
        </div>
        {previewSurface ? (
          <TmuxPeekPanel
            surface={previewSurface}
            lines={28}
            columns={112}
            className="s-term-multiplexer-peek"
          />
        ) : (
          <div className="s-term-picker-empty">This host does not expose a web preview</div>
        )}
      </section>
    </div>
  );
}

function TerminalAgentPicker({
  agents,
  items,
  attachedIds,
  onAttach,
  navigate,
}: {
  agents: Agent[];
  items: TerminalHomeListItem[];
  attachedIds: Set<string>;
  onAttach: (target: RegisteredTerminalTarget) => void;
  navigate: TerminalNavigate;
}) {
  if (agents.length === 0) return <div className="s-term-picker-empty">No terminal-backed agents</div>;
  return (
    <div className="s-term-picker-list" aria-label="Terminal-backed agents">
      {agents.map((agent) => {
        const surface = resolveAgentTerminalSurface(agent);
        const item = items.find((candidate) => findTerminalItemAgent(candidate, [agent])?.id === agent.id) ?? null;
        const target = item ? registeredTargetFromListItem(item) : null;
        const attached = target ? attachedIds.has(registeredTerminalTargetKey(target)) : false;
        return (
          <article
            key={agent.id}
            className={`s-term-picker-item${attached ? " s-term-picker-item--attached" : ""}`}
            data-picker-item-id={item?.id}
          >
            <span className="s-term-picker-grip" aria-hidden="true">
              <span className="s-term-picker-agent-dot" data-state={agent.state} />
            </span>
            <div className="s-term-picker-item-main">
              <strong title={agent.name}>{agent.name}</strong>
              <span title={agent.cwd ?? agent.projectRoot ?? undefined}>{agent.handle ? `@${agent.handle}` : compactTerminalPath(agent.cwd ?? agent.projectRoot)}</span>
            </div>
            <div className="s-term-picker-item-meta">
              <span>{surface?.backend ?? agent.harness}</span>
              <span>{agentStateLabel(agent.state)}</span>
              <span>{terminalAgentProject(agent)}</span>
            </div>
            <button
              type="button"
              className="s-term-picker-add"
              onClick={() => navigate({ view: "terminal", agentId: agent.id, mode: "takeover" })}
            >
              Open
            </button>
            <button
              type="button"
              className="s-term-picker-add"
              onClick={() => target && onAttach(target)}
              disabled={!target || attached}
              title={!target ? "This agent has no registered terminal surface to add" : undefined}
            >
              {attached ? "In grid" : "Add"}
            </button>
          </article>
        );
      })}
    </div>
  );
}

/**
 * The session picker's rows, in either presentation.
 *
 * One component for both the compact list and the sortable table, because they
 * are the same inventory answering two different questions: "what is there"
 * and "which of these do I want". Sorting is client-side over the rows the
 * host adapters already returned — no second probing path.
 */
function TerminalSessionPicker({
  items,
  view,
  sort,
  attachedIds,
  draggedTargetId,
  onSort,
  onAttach,
  navigate,
  groupManaged = true,
}: {
  items: TerminalHomeListItem[];
  view: TerminalPickerView;
  sort: TerminalSessionSort;
  attachedIds: Set<string>;
  draggedTargetId: string | null;
  onSort: (column: TerminalSessionColumn) => void;
  onAttach: (target: RegisteredTerminalTarget) => void;
  navigate?: TerminalNavigate;
  groupManaged?: boolean;
}) {
  const rows = useMemo(() => sortTerminalSessionItems(items, sort), [items, sort]);
  // Multiplexer sessions — herdr, tmux, and zellij, where the host owns the
  // durable layout — get their own section above plain PTY sessions.
  const { managed, regular } = useMemo(
    () => groupManaged ? partitionTerminalListItems(items) : { managed: [], regular: items },
    [groupManaged, items],
  );
  const managedRows = useMemo(() => sortTerminalSessionItems(managed, sort), [managed, sort]);
  const regularRows = useMemo(() => sortTerminalSessionItems(regular, sort), [regular, sort]);
  const openItem = (item: TerminalHomeListItem) => {
    navigate?.({
      view: "terminal",
      terminalSessionId: item.session.id,
      terminalSurfaceKey: surfaceKey(item.surface),
    });
  };
  const renderPickerItem = (item: TerminalHomeListItem, managedSection: boolean) => {
    const targetId = registeredTerminalTargetKey(registeredTargetFromListItem(item));
    return (
      <TerminalPickerItem
        key={item.id}
        item={item}
        attached={attachedIds.has(targetId)}
        dragging={draggedTargetId === targetId}
        onAttach={onAttach}
        onOpen={managedSection && navigate ? () => openItem(item) : undefined}
      />
    );
  };

  if (view === "table") {
    return (
      <div className="s-term-picker-table-wrap">
        <table className="s-term-picker-table">
          <thead>
            <tr>
              {TERMINAL_SESSION_COLUMNS.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={sort.column === column.id
                    ? (sort.direction === "asc" ? "ascending" : "descending")
                    : "none"}
                >
                  <button type="button" onClick={() => onSort(column.id)}>
                    <span>{column.label}</span>
                    <em aria-hidden="true">
                      {sort.column === column.id ? (sort.direction === "asc" ? "▲" : "▼") : "·"}
                    </em>
                  </button>
                </th>
              ))}
              <th scope="col" aria-label="Place" />
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const targetId = registeredTerminalTargetKey(registeredTargetFromListItem(item));
              const activityAt = terminalSessionActivityAt(item);
              return (
                <tr
                  key={item.id}
                  data-picker-item-id={item.id}
                  className={attachedIds.has(targetId) ? "is-attached" : undefined}
                >
                  <td title={item.surface.sessionName}>{item.title}</td>
                  <td>{item.surface.backend}</td>
                  <td>{terminalSessionStateLabel(item)}</td>
                  <td title={item.session.cwd ?? undefined}>{item.project}</td>
                  <td>{activityAt ? timeAgo(activityAt) : "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="s-term-picker-add"
                      onClick={() => onAttach(registeredTargetFromListItem(item))}
                      disabled={attachedIds.has(targetId)}
                    >
                      {attachedIds.has(targetId) ? "In grid" : "Add"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="s-term-picker-list" aria-label="Available terminals">
      {managedRows.length > 0 && (
        <section className="s-term-picker-group" aria-label="Managed sessions">
          <h3 className="s-term-picker-group-title">Managed sessions</h3>
          {managedRows.map((item) => renderPickerItem(item, true))}
        </section>
      )}
      {managedRows.length > 0 && regularRows.length > 0 ? (
        <section className="s-term-picker-group" aria-label="Terminals">
          <h3 className="s-term-picker-group-title">Terminals</h3>
          {regularRows.map((item) => renderPickerItem(item, false))}
        </section>
      ) : (
        regularRows.map((item) => renderPickerItem(item, false))
      )}
    </div>
  );
}

function TerminalWorkspaceTile({
  tile,
  navigate,
  onClose,
  resolution,
  onRevive,
  live = false,
}: {
  tile: TerminalWorkspaceTileModel;
  navigate: TerminalNavigate;
  onClose: (tileId: string) => void;
  resolution?: TerminalWorkspaceResolution["cells"][number] | null;
  onRevive?: (cellId: string) => void;
  /** Whether a host session with this tile's name is currently live. */
  live?: boolean;
}) {
  if (tile.kind === "registered") {
    // A registered herdr cell binds to the whole herdr session, and herdr owns
    // the layout — so it projects the session's live topology like a hosted
    // tile does, instead of a relay canvas that could never connect.
    if (tile.target.surface.backend === "herdr") {
      return (
        <HostedTerminalWorkspaceTile
          tileId={tile.id}
          backend="herdr"
          sessionName={tile.target.surface.sessionName}
          live={tile.target.surface.state === "live"}
          onClose={onClose}
          navigate={navigate}
        />
      );
    }
    return (
      <RegisteredTerminalWorkspaceTile
        tile={tile}
        navigate={navigate}
        onClose={onClose}
      />
    );
  }
  if (tile.kind === "unavailable") {
    // The server decides whether this cell can come back, because that answer
    // depends on the host inventory. A revive button appears only when it said
    // yes; otherwise the tile says plainly why not.
    const revivable = resolution?.status === "revivable" && Boolean(onRevive);
    return (
      <section className="s-term-workspace-tile s-term-workspace-tile--unavailable" aria-label="Unavailable terminal session">
        <div className="s-term-bar">
          <div className="s-term-bar-left">
            <span className="s-term-workspace-tile-mark"><TerminalIcon size={14} strokeWidth={1.8} /></span>
            <span className="s-term-workspace-tile-name">Not running</span>
          </div>
          <div className="s-term-bar-actions">
            <button
              type="button"
              className="s-term-icon-button s-term-icon-button--danger"
              onClick={() => onClose(tile.id)}
              title="Remove cell"
              aria-label="Remove cell"
            >
              <X size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="s-term-workspace-unavailable-body">
          <TerminalIcon size={22} strokeWidth={1.5} />
          <strong>{revivable ? "This tile is not running." : "This saved session is not currently live."}</strong>
          <span>
            {resolution?.detail
              ?? "Show the terminal picker to replace it, or wait for the session to reconnect."}
          </span>
          {revivable && (
            <button
              type="button"
              className="s-term-workspace-action s-term-workspace-action--primary"
              onClick={() => onRevive?.(tile.id)}
            >
              Start it again
            </button>
          )}
        </div>
      </section>
    );
  }
  // A host the browser relay cannot render still gets a real tile: Scout
  // creates and tracks the session, and the tile says where to use it. The
  // alternative — handing an unsupported backend to the relay — is a spinner
  // that never connects.
  if (!isRelayCapableTerminalBackend(tile.backend) && tile.backend !== "pty") {
    return (
      <HostedTerminalWorkspaceTile
        tileId={tile.id}
        backend={tile.backend}
        sessionName={tile.sessionName}
        live={live}
        onClose={onClose}
        navigate={navigate}
      />
    );
  }
  return (
    <FreshTerminalWorkspaceTile
      tile={tile}
      navigate={navigate}
      onClose={onClose}
    />
  );
}

function HostedTerminalWorkspaceTile({
  tileId,
  backend,
  sessionName,
  live,
  onClose,
  navigate,
}: {
  tileId: string;
  backend: TerminalCellBackend;
  sessionName?: string;
  live: boolean;
  onClose: (tileId: string) => void;
  navigate?: TerminalNavigate;
}) {
  const { hosts } = useTerminalHosts();
  const host = terminalHostById(hosts, backend);
  const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  // Herdr tiles project the session's real topology instead of a bare "running
  // elsewhere" placeholder — the whole point of hosting herdr is that it knows
  // which agent is doing what. Only polled while the session is live.
  const isHerdr = backend === "herdr";
  const { topology } = useHerdrTopology(isHerdr ? (sessionName ?? null) : null, {
    enabled: isHerdr && live,
  });

  const start = useCallback(() => {
    if (!sessionName) return;
    setState("starting");
    setError(null);
    void createTerminalHostSession(backend, { sessionName })
      .then(() => setState("idle"))
      .catch((cause) => {
        setState("failed");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [backend, sessionName]);

  const openProjection = useCallback(() => {
    if (!navigate || !sessionName) return;
    const surfaceKey = surfaceKeyFromParts(backend, sessionName);
    if (surfaceKey) navigate({ view: "terminal", terminalSurfaceKey: surfaceKey });
  }, [navigate, backend, sessionName]);

  // Straight into the session: a web terminal running the full herdr client,
  // skipping the projection. Herdr-only — other hosted backends have no relay.
  const enterTerminal = useCallback(() => {
    if (!navigate || !sessionName) return;
    navigate(herdrTerminalRoute(sessionName));
  }, [navigate, sessionName]);

  const herdrTabs = isHerdr && topology?.running
    ? topology.workspaces.flatMap((workspace) => workspace.tabs)
    : [];

  return (
    <section className="s-term-workspace-tile s-term-workspace-tile--hosted" aria-label={`${host?.label ?? backend} session`}>
      <div className="s-term-bar">
        <div className="s-term-bar-left">
          <span className="s-term-workspace-tile-mark"><TerminalIcon size={14} strokeWidth={1.8} /></span>
          <span className="s-term-workspace-tile-name">{host?.label ?? backend}</span>
        </div>
        <div className="s-term-bar-meta">
          <span className="s-term-label">{live ? "running" : "not running"}</span>
          {sessionName && <span className="s-term-session" title={sessionName}>{sessionName}</span>}
        </div>
        <div className="s-term-bar-actions">
          {isHerdr && live && sessionName && navigate && (
            <button
              type="button"
              className="s-term-icon-button"
              onClick={enterTerminal}
              title="Enter — open a live web terminal attached to this session"
              aria-label="Enter — open a live web terminal attached to this session"
            >
              <LogIn size={14} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            className="s-term-icon-button s-term-icon-button--danger"
            onClick={() => onClose(tileId)}
            title="Remove cell"
            aria-label="Remove cell"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {herdrTabs.length > 0 ? (
        <button type="button" className="s-term-workspace-hosted-body s-term-workspace-hosted-body--link" onClick={openProjection}>
          {herdrTabs.map((tab) => {
            const summary = herdrTabSummary(tab);
            return (
              <span className="s-term-workspace-hosted-tab" key={tab.tabId}>
                <span className="s-term-workspace-hosted-tab-dots">
                  {summary.statuses.map((status, index) => (
                    <AgentStatusDot key={`${tab.tabId}:${index}`} status={status} />
                  ))}
                </span>
                <span className="s-term-workspace-hosted-tab-label">{summary.label}</span>
                <span className="s-term-workspace-hosted-tab-count">{summary.statuses.length}</span>
              </span>
            );
          })}
        </button>
      ) : (
        <div className="s-term-workspace-unavailable-body">
          <TerminalIcon size={22} strokeWidth={1.5} />
          <strong>{live ? `Running in ${host?.label ?? backend}` : `Not running yet`}</strong>
          <span>
            {live
              ? `Scout keeps this session for you. Open it in ${host?.label ?? backend} to use it.`
              : `Scout can start a ${host?.label ?? backend} session and keep it for you.`}
          </span>
          {!live && (
            <button
              type="button"
              className="s-term-workspace-action s-term-workspace-action--primary"
              onClick={start}
              disabled={state === "starting" || !sessionName}
            >
              {state === "starting" ? "Starting…" : "Start it"}
            </button>
          )}
          {error && <code>{error}</code>}
        </div>
      )}
    </section>
  );
}

function FreshTerminalWorkspaceTile({
  tile,
  navigate,
  onClose,
}: {
  tile: FreshTerminalTileModel;
  navigate: TerminalNavigate;
  onClose: (tileId: string) => void;
}) {
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const relayUrl = resolveScoutTerminalRelayUrl();
  const healthUrl = resolveScoutTerminalRelayHealthUrl();
  const label = freshTerminalLabel(tile.backend, tile.agent);
  const route = freshTerminalRouteForTile(tile);
  const sessionKey = [
    "scout-terminal-workspace",
    tile.id,
    tile.backend,
    tile.agent,
    tile.sessionName ?? "pty",
  ].join("-");

  const relay = useTerminalRelay({
    url: relayUrl,
    healthUrl,
    autoConnect: true,
    sessionKey,
    backend: tile.backend,
    ...(tile.sessionName ? { terminalSession: tile.sessionName } : {}),
    ...(tile.backend === "tmux" && tile.sessionName ? { tmuxSession: tile.sessionName } : {}),
    ...(tile.backend === "zellij" && tile.sessionName ? { zellijSession: tile.sessionName } : {}),
    ...(tile.backend === "zellij" && tile.zellijSocketDir ? { zellijSocketDir: tile.zellijSocketDir } : {}),
    // hudsonkit's session:init forwards tmuxSession, not herdrSession; the
    // relay reads herdrSession || tmuxSession for backend 'herdr'.
    ...(tile.backend === "herdr" && tile.sessionName ? { tmuxSession: tile.sessionName } : {}),
    agent: tile.agent,
    controlMode: "takeover",
  } as ScoutTerminalRelayOptions as HudsonTerminalRelayOptions);

  useBrowserLayoutEffect(() => {
    relay.resize(SCOUT_TERMINAL_INITIAL_COLS, SCOUT_TERMINAL_INITIAL_ROWS);
  }, [relay.resize]);

  const openStandalone = useCallback(() => {
    if (route) openTerminalRouteExternally(route, navigate);
  }, [navigate, route]);

  return (
    <section className="s-term-workspace-tile" aria-label={label.title}>
      <div className="s-term s-term--embedded">
        <div className="s-term-bar s-term-bar--fresh">
          <div className="s-term-bar-left">
            <span className="s-term-workspace-tile-mark">
              <TerminalIcon size={14} strokeWidth={1.8} />
            </span>
            <span className="s-term-workspace-tile-name">{label.title}</span>
          </div>
          <div className="s-term-bar-meta">
            <span className="s-term-label">{tile.backend}</span>
            <span className="s-term-session">{label.detail}</span>
          </div>
          <div className="s-term-bar-actions">
            <button
              type="button"
              className="s-term-icon-button"
              onClick={() => relay.restart()}
              title="Restart terminal"
              aria-label="Restart terminal"
            >
              <RefreshCw size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="s-term-icon-button"
              onClick={openStandalone}
              title="Open terminal in a new window"
              aria-label="Open terminal in a new window"
            >
              <ExternalLink size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="s-term-icon-button s-term-icon-button--danger"
              onClick={() => onClose(tile.id)}
              title="Close tile"
              aria-label="Close tile"
            >
              <X size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div
          ref={terminalBodyRef}
          className="s-term-body"
          onMouseDown={() => {
            terminalBodyRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
            terminalBodyRef.current?.querySelector<HTMLElement>(".xterm")?.focus();
          }}
        >
          <ScoutTerminalRelay
            relay={relay}
            quiet
            configItems={[
              { label: "backend", value: tile.backend },
              { label: "agent", value: tile.agent },
              ...(tile.sessionName ? [{ label: "session", value: tile.sessionName }] : []),
              ...(tile.zellijSocketDir ? [{ label: "socket", value: tile.zellijSocketDir }] : []),
              { label: "ws", value: relayUrl },
              { label: "health", value: healthUrl },
            ]}
          />
        </div>
      </div>
    </section>
  );
}

function RegisteredTerminalWorkspaceTile({
  tile,
  navigate,
  onClose,
}: {
  tile: RegisteredTerminalTileModel;
  navigate: TerminalNavigate;
  onClose: (tileId: string) => void;
}) {
  const openStandalone = useCallback(() => {
    openTerminalRouteExternally(registeredTerminalRouteForTarget(tile.target), navigate);
  }, [navigate, tile.target]);

  return (
    <section className="s-term-workspace-tile" aria-label={tile.target.surface.sessionName}>
      <TerminalRelayCanvas
        agent={null}
        mode="takeover"
        navigate={navigate}
        registeredTarget={tile.target}
        embedded
        tileActions={(
          <>
            <button
              type="button"
              className="s-term-icon-button"
              onClick={openStandalone}
              title="Open terminal in a new window"
              aria-label="Open terminal in a new window"
            >
              <ExternalLink size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="s-term-icon-button s-term-icon-button--danger"
              onClick={() => onClose(tile.id)}
              title="Close tile"
              aria-label="Close tile"
            >
              <X size={14} strokeWidth={1.8} />
            </button>
          </>
        )}
      />
    </section>
  );
}

function TerminalHomeSessionRow({
  item,
  matchingAgent,
  navigate,
  showContextMenu,
  onAttach,
}: {
  item: TerminalHomeListItem;
  matchingAgent: Agent | null;
  navigate: TerminalNavigate;
  showContextMenu: (event: ReactMouseEvent, items: MenuItem[]) => void;
  onAttach?: (target: RegisteredTerminalTarget) => void;
}) {
  const routeBase: TerminalRoute = {
    view: "terminal" as const,
    terminalSessionId: item.session.id,
    terminalSurfaceKey: surfaceKey(item.surface),
  };
  const project = matchingAgent ? terminalAgentProject(matchingAgent) : item.project;
  const projectDetail = matchingAgent
    ? matchingAgent.branch ?? (compactTerminalPath(matchingAgent.cwd ?? matchingAgent.projectRoot) || "no workspace path")
    : item.cwdLabel || (item.origin === "backend" ? "no cwd reported" : "no workspace path");
  const context = matchingAgent
    ? terminalAgentContext(matchingAgent)
    : { kind: item.contextKind, value: item.contextValue };
  const contextTitle = `${context.kind}: ${context.value}`;
  const runningDetail = terminalItemRunningDetail(item, matchingAgent);
  const ownerName = matchingAgent?.name ?? (item.origin === "backend" ? "Standalone" : item.session.harness ?? "Scout");
  const ownerSub = matchingAgent?.handle
    ? `@${matchingAgent.handle}`
    : matchingAgent?.id ?? (item.origin === "backend" ? `${item.surface.backend} session` : item.origin);
  const ownerTitle = matchingAgent
    ? `${matchingAgent.name}${matchingAgent.handle ? ` @${matchingAgent.handle}` : ""}`
    : item.origin === "backend"
      ? "Backend discovery"
      : item.session.harness ?? "Scout session";
  const updatedAt = maxTimestamp(item.session.updatedAt, matchingAgent?.updatedAt);
  const updated = formatTableTime(updatedAt);
  const actionItems: MenuItem[] = [
    ...(onAttach
      ? [
          {
            kind: "action" as const,
            label: "Add Tile",
            onSelect: () => onAttach(registeredTargetFromListItem(item)),
          },
          { kind: "separator" as const },
        ]
      : []),
    {
      kind: "action",
      label: "Observe Read-only",
      onSelect: () => navigate(withTerminalMode(routeBase, "observe")),
    },
    {
      kind: "action",
      label: "Open Summary",
      onSelect: () => navigate(routeBase),
    },
    {
      kind: "action",
      label: "Open In New Window",
      onSelect: () => openTerminalRouteExternally({ ...routeBase, mode: "takeover" }, navigate),
    },
  ];

  return (
    <div className="s-term-data-row" role="row">
      <button
        type="button"
        className="s-term-data-cell s-term-data-primary"
        role="cell"
        onClick={() => navigate(routeBase)}
      >
        <span className="s-term-home-row-icon" aria-hidden>
          <TerminalIcon size={15} strokeWidth={1.8} />
        </span>
        <span className="s-term-home-row-copy">
          <span className="s-term-home-row-title" title={item.surface.sessionName}>{item.title}</span>
          <span className="s-term-home-row-detail">{item.cwdLabel || item.detail}</span>
        </span>
      </button>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-main" title={ownerTitle}>{ownerName}</span>
        <span className="s-term-data-sub" title={matchingAgent?.id ?? ownerSub}>{ownerSub}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-main" title={project}>{project}</span>
        <span className="s-term-data-sub" title={projectDetail}>{projectDetail}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-kicker">{context.kind}</span>
        <span className="s-term-data-main" title={contextTitle}>{compactReference(context.value)}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-home-row-badges">
          <span>{item.surface.backend}</span>
          <span>{item.condition}</span>
        </span>
        <span className="s-term-data-sub" title={runningDetail}>{runningDetail}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-main" title={formatTableDate(updatedAt)}>{updated}</span>
      </div>
      <div className="s-term-home-row-actions" role="cell">
        <button
          type="button"
          className="s-term-summary-action s-term-summary-action--primary"
          onClick={() => navigate(withTerminalMode(routeBase, "takeover"))}
        >
          <LogIn size={13} strokeWidth={1.8} />
          <span>Enter</span>
        </button>
        <button
          type="button"
          className="s-term-summary-action s-term-row-more"
          onClick={(event) => showContextMenu(event, actionItems)}
          title="More terminal actions"
          aria-label="More terminal actions"
        >
          <MoreHorizontal size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

function TerminalHomeAgentRow({
  agent,
  navigate,
  showContextMenu,
}: {
  agent: Agent;
  navigate: TerminalNavigate;
  showContextMenu: (event: ReactMouseEvent, items: MenuItem[]) => void;
}) {
  const terminalSurface = resolveAgentTerminalSurface(agent);
  if (!terminalSurface) return null;

  const routeBase: TerminalRoute = { view: "terminal" as const, agentId: agent.id };
  const takeoverRoute: TerminalRoute = { ...routeBase, mode: "takeover" };
  const observeRoute: TerminalRoute = { ...routeBase, mode: "observe" };
  const project = terminalAgentProject(agent);
  const projectDetail = agent.branch ?? (compactTerminalPath(agent.cwd ?? agent.projectRoot) || "no workspace path");
  const context = terminalAgentContext(agent);
  const terminalTitle = compactTerminalName(terminalSurface.sessionName);
  const runtimeDetail = [agent.harness, agent.model ?? agent.transport].filter(Boolean).join(" · ")
    || agentStateLabel(agent.state);
  const updated = formatTableTime(agent.updatedAt);
  const actionItems: MenuItem[] = [
    {
      kind: "action",
      label: "Observe Read-only",
      onSelect: () => navigate(observeRoute),
    },
    {
      kind: "action",
      label: "Open In New Window",
      onSelect: () => openTerminalRouteExternally(takeoverRoute, navigate),
    },
  ];

  return (
    <div className="s-term-data-row" role="row">
      <button
        type="button"
        className="s-term-data-cell s-term-data-primary"
        role="cell"
        onClick={() => navigate(takeoverRoute)}
      >
        <span className="s-term-home-row-icon" aria-hidden>
          <TerminalIcon size={15} strokeWidth={1.8} />
        </span>
        <span className="s-term-home-row-copy">
          <span className="s-term-home-row-title" title={terminalSurface.sessionName}>{terminalTitle}</span>
          <span className="s-term-home-row-detail">{projectDetail}</span>
        </span>
      </button>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-main" title={agent.name}>{agent.name}</span>
        <span className="s-term-data-sub" title={agent.id}>{agent.handle ? `@${agent.handle}` : agent.id}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-main" title={project}>{project}</span>
        <span className="s-term-data-sub" title={projectDetail}>{projectDetail}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-kicker">{context.kind}</span>
        <span className="s-term-data-main" title={context.value}>{compactReference(context.value)}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-home-row-badges">
          <span>{terminalSurface.backend}</span>
          <span>bound</span>
        </span>
        <span className="s-term-data-sub" title={runtimeDetail}>{runtimeDetail}</span>
      </div>
      <div className="s-term-data-cell" role="cell">
        <span className="s-term-data-main" title={formatTableDate(agent.updatedAt)}>{updated}</span>
        <span className="s-term-data-sub">{agentStateLabel(agent.state)}</span>
      </div>
      <div className="s-term-home-row-actions" role="cell">
        <button
          type="button"
          className="s-term-summary-action s-term-summary-action--primary"
          onClick={() => navigate(takeoverRoute)}
        >
          <LogIn size={13} strokeWidth={1.8} />
          <span>Enter</span>
        </button>
        <button
          type="button"
          className="s-term-summary-action s-term-row-more"
          onClick={(event) => showContextMenu(event, actionItems)}
          title="More terminal actions"
          aria-label="More terminal actions"
        >
          <MoreHorizontal size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

function buildTerminalInventoryRows(items: TerminalHomeListItem[], agents: Agent[]): TerminalInventoryRow[] {
  const representedAgentIds = new Set<string>();
  const rows: TerminalInventoryRow[] = items.map((item) => {
    const matchingAgent = findTerminalItemAgent(item, agents);
    if (matchingAgent) representedAgentIds.add(matchingAgent.id);
    return {
      id: `session:${item.id}`,
      kind: "session",
      item,
      matchingAgent,
      updatedAt: maxTimestamp(item.session.updatedAt, matchingAgent?.updatedAt),
    };
  });

  for (const agent of agents) {
    if (representedAgentIds.has(agent.id)) continue;
    const terminalSurface = resolveAgentTerminalSurface(agent);
    if (!terminalSurface) continue;
    rows.push({
      id: `agent:${agent.id}:${terminalSurface.backend}:${terminalSurface.sessionName}`,
      kind: "agent",
      agent,
      updatedAt: maxTimestamp(agent.updatedAt),
    });
  }

  return rows.sort((a, b) => {
    const updatedRank = b.updatedAt - a.updatedAt;
    if (updatedRank !== 0) return updatedRank;
    return terminalInventorySortLabel(a).localeCompare(terminalInventorySortLabel(b));
  });
}

function terminalInventorySortLabel(row: TerminalInventoryRow): string {
  if (row.kind === "session") return `${row.item.title} ${row.matchingAgent?.name ?? ""}`;
  const surface = resolveAgentTerminalSurface(row.agent);
  return `${surface?.sessionName ?? ""} ${row.agent.name}`;
}

function sortTerminalAgents(agents: Agent[]): Agent[] {
  return [...agents]
    .filter((agent) => !agent.retiredFromFleet)
    .sort((a, b) => {
      const surfaceRank = Number(Boolean(resolveAgentTerminalSurface(b))) - Number(Boolean(resolveAgentTerminalSurface(a)));
      if (surfaceRank !== 0) return surfaceRank;
      const updatedRank = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      if (updatedRank !== 0) return updatedRank;
      return a.name.localeCompare(b.name);
    });
}

function findTerminalItemAgent(item: TerminalHomeListItem, agents: Agent[]): Agent | null {
  const itemSurfaceKey = surfaceKey(item.surface);
  const bySurface = agents.find((agent) => {
    // One matcher, not a hand-rolled `backend:name` string. `surfaceKey` now
    // returns the opaque handle, so the interpolated comparison this replaces
    // could never be true and the primary agent-to-surface binding silently
    // fell through to the name aliases below.
    const surface = resolveAgentTerminalSurface(agent);
    return surface ? terminalSurfaceMatchesId(surface, itemSurfaceKey) : false;
  });
  if (bySurface) return bySurface;

  const aliases = new Set([
    item.session.id,
    item.session.sourceSessionId,
    item.surface.sessionName,
  ].map((value) => value.trim()).filter(Boolean));
  return agents.find((agent) =>
    [
      agent.harnessSessionId,
      agent.conversationId,
      agent.terminalSurface?.sessionName,
    ].some((value) => value && aliases.has(value))
  ) ?? null;
}

function terminalItemRunningDetail(item: TerminalHomeListItem, matchingAgent: Agent | null): string {
  const command = terminalMetadataString(item.session.metadata, "currentCommand");
  const path = compactTerminalPath(terminalMetadataString(item.session.metadata, "currentPath"));
  if (command && path) return `${command} in ${path}`;
  if (command) return `running ${command}`;
  if (matchingAgent?.handle) return `owned by @${matchingAgent.handle}`;
  if (matchingAgent) return `owned by ${matchingAgent.name}`;
  if (item.surface.paneId) return `pane ${item.surface.paneId}`;
  const windows = terminalMetadataNumber(item.session.metadata, "windows");
  if (windows !== null) return `${windows} window${windows === 1 ? "" : "s"}`;
  return `${item.surface.backend} surface`;
}

function maxTimestamp(...values: Array<number | null | undefined>): number {
  return values.reduce<number>((current, value) => {
    return typeof value === "number" && Number.isFinite(value) && value > current ? value : current;
  }, 0);
}

function terminalMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function terminalMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function terminalAgentProject(agent: Agent): string {
  return agent.project
    ?? basename(agent.projectRoot)
    ?? basename(agent.cwd)
    ?? agent.workspaceQualifier
    ?? agent.definitionId;
}

function terminalAgentContext(agent: Agent): { kind: string; value: string } {
  if (agent.conversationId) return { kind: "conversation", value: agent.conversationId };
  if (agent.harnessSessionId) return { kind: "session", value: agent.harnessSessionId };
  if (agent.terminalSurface?.sessionName) return { kind: "terminal", value: agent.terminalSurface.sessionName };
  if (agent.nodeQualifier) return { kind: "node", value: agent.nodeQualifier };
  return { kind: "agent", value: agent.id };
}

function compactReference(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "n/a";
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(trimmed)) return trimmed.slice(0, 8);
  if (trimmed.length <= 34) return trimmed;
  return `${trimmed.slice(0, 22)}...${trimmed.slice(-8)}`;
}

function formatTableTime(ts: number | null | undefined): string {
  if (!ts) return "unknown";
  const deltaMs = Date.now() - ts;
  const absDeltaMs = Math.abs(deltaMs);
  if (absDeltaMs < 60_000) return "now";
  if (deltaMs > 0 && deltaMs < 60 * 60_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs > 0 && deltaMs < 24 * 60 * 60_000) return `${Math.floor(deltaMs / (60 * 60_000))}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ts));
}

function formatTableDate(ts: number | null | undefined): string {
  if (!ts) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ts));
}

function basename(path: string | null | undefined): string | null {
  const trimmed = path?.trim().replace(/\/+$/u, "");
  if (!trimmed) return null;
  return trimmed.split("/").pop() || trimmed;
}

function NewTerminalSession({
  route,
  navigate,
}: {
  route: TerminalRoute;
  navigate: TerminalNavigate;
}) {
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const backend = route.terminalBackend ?? "pty";
  const agent = route.terminalAgent ?? "shell";
  const tabId = route.terminalTabId ?? "adhoc";
  const generatedSessionName = backend === "pty" ? undefined : `scout-${backend}-${tabId}`;
  const sessionName = route.terminalSessionName ?? generatedSessionName;
  const relayUrl = resolveScoutTerminalRelayUrl();
  const healthUrl = resolveScoutTerminalRelayHealthUrl();
  const label = freshTerminalLabel(backend, agent);
  const sessionKey = [
    "scout-terminal-new",
    backend,
    agent,
    sessionName ?? tabId,
  ].join("-");

  const relay = useTerminalRelay({
    url: relayUrl,
    healthUrl,
    autoConnect: true,
    sessionKey,
    backend,
    ...(sessionName ? { terminalSession: sessionName } : {}),
    ...(backend === "tmux" && sessionName ? { tmuxSession: sessionName } : {}),
    ...(backend === "zellij" && sessionName ? { zellijSession: sessionName } : {}),
    ...(backend === "zellij" && route.zellijSocketDir ? { zellijSocketDir: route.zellijSocketDir } : {}),
    // hudsonkit's session:init forwards tmuxSession, not herdrSession; the
    // relay reads herdrSession || tmuxSession for backend 'herdr'.
    ...(backend === "herdr" && sessionName ? { tmuxSession: sessionName } : {}),
    agent,
    controlMode: "takeover",
  } as ScoutTerminalRelayOptions as HudsonTerminalRelayOptions);

  const pendingHostLinesRef = useRef<string[]>([]);
  const hostRelayRef = useRef({ status: relay.status, sendLine: relay.sendLine });
  hostRelayRef.current = { status: relay.status, sendLine: relay.sendLine };

  useBrowserLayoutEffect(() => {
    const handleHostLine = (event: Event) => {
      const line = terminalHostLineFromEvent(event);
      if (!line) return;
      const currentRelay = hostRelayRef.current;
      if (currentRelay.status === "connected") {
        currentRelay.sendLine(line);
        return;
      }
      pendingHostLinesRef.current = [...pendingHostLinesRef.current.slice(-15), line];
    };

    window.addEventListener(SCOUT_TERMINAL_SEND_LINE_EVENT, handleHostLine);
    return () => window.removeEventListener(SCOUT_TERMINAL_SEND_LINE_EVENT, handleHostLine);
  }, []);

  useBrowserLayoutEffect(() => {
    if (relay.status !== "connected" || pendingHostLinesRef.current.length === 0) return;
    const lines = pendingHostLinesRef.current;
    pendingHostLinesRef.current = [];
    for (const line of lines) relay.sendLine(line);
  }, [relay.sendLine, relay.status]);

  useBrowserLayoutEffect(() => {
    relay.resize(SCOUT_TERMINAL_INITIAL_COLS, SCOUT_TERMINAL_INITIAL_ROWS);
  }, [relay.resize]);

  return (
    <div className="s-term">
      <div className="s-term-bar">
        <BackToPicker
          slot="terminal"
          fallback={{ view: "terminal" }}
          navigate={navigate}
          className="s-term-back"
        />
        <span className="s-term-label">{label.title}</span>
        <div className="s-term-status">{label.detail}</div>
        <div className="s-term-actions">
          <button
            type="button"
            className="s-term-icon-button"
            onClick={() => relay.restart()}
            title="Restart terminal"
            aria-label="Restart terminal"
          >
            <RefreshCw size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div
        ref={terminalBodyRef}
        className="s-term-body"
        onMouseDown={() => {
          terminalBodyRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
          terminalBodyRef.current?.querySelector<HTMLElement>(".xterm")?.focus();
        }}
      >
        <ScoutTerminalRelay
          relay={relay}
          quiet
          configItems={[
            { label: "backend", value: backend },
            { label: "agent", value: agent },
            ...(sessionName ? [{ label: "session", value: sessionName }] : []),
            ...(route.zellijSocketDir ? [{ label: "socket", value: route.zellijSocketDir }] : []),
            { label: "ws", value: relayUrl },
            { label: "health", value: healthUrl },
          ]}
        />
      </div>
    </div>
  );
}

function freshTerminalLabel(
  backend: TerminalCellBackend,
  agent: NonNullable<TerminalRoute["terminalAgent"]>,
): { title: string; detail: string } {
  const agentLabel = agent === "shell"
    ? "Shell"
    : agent === "codex"
      ? "Codex"
      : agent === "pi"
        ? "Pi"
        : "Claude";
  if (backend === "pty") {
    return { title: agentLabel, detail: "fresh PTY tab" };
  }
  return { title: `${agentLabel} ${backend}`, detail: `fresh ${backend} backed tab` };
}

function TerminalTakeoverGate({
  agentId,
  agent,
  mode,
  navigate,
  children,
}: {
  agentId: string;
  agent: Agent;
  mode?: "observe" | "takeover";
  navigate: TerminalNavigate;
  children: ReactNode;
}) {
  const bootstrap = useTerminalTakeoverBootstrap(agentId, agent, mode);
  if (!bootstrap.ready) {
    return (
      <TerminalPlaceholder
        agent={agent}
        agentId={agentId}
        color={actorColor(agent.name)}
        navigate={navigate}
        label={bootstrap.label}
        status={bootstrap.status}
        onRetry={bootstrap.onRetry}
      />
    );
  }
  return <>{children}</>;
}

function ResolvingAgent({ navigate }: { navigate: TerminalNavigate }) {
  return (
    <div className="s-term">
      <div className="s-term-bar">
        <BackToPicker
          slot="terminal"
          fallback={{ view: "terminal" }}
          navigate={navigate}
          className="s-term-back"
        />
        <span className="s-term-label">Terminal</span>
        <div className="s-term-status">Resolving agent...</div>
      </div>
    </div>
  );
}

export function TerminalContent({ route, navigate }: TerminalContentProps) {
  const { agentId, mode, terminalSessionId, terminalSurfaceKey } = route;
  const { agents } = useScout();

  if (route.terminalBackend) {
    return <NewTerminalSession route={route} navigate={navigate} />;
  }

  // A herdr surface's deep link (`/terminal/herdr/<name>`) opens the session
  // projection: the layout replica and pane handoffs, with the relay terminal
  // one "Open terminal" away.
  const herdrSurface = route.terminalSurfaceKey ? parseTerminalSurfaceId(route.terminalSurfaceKey) : null;
  if (!agentId && herdrSurface?.backend === "herdr") {
    return <HerdrSessionScreen sessionName={herdrSurface.hostSession} navigate={navigate} />;
  }

  if (!agentId) {
    if (!terminalSessionId && !terminalSurfaceKey) {
      return <TerminalHome navigate={navigate} />;
    }
    return (
      <RegisteredTerminalSessions
        terminalSessionId={terminalSessionId}
        terminalSurfaceKey={terminalSurfaceKey}
        mode={mode}
        navigate={navigate}
      />
    );
  }

  const agent = agents.find((candidate) => candidate.id === agentId) ?? null;
  if (!agent) {
    return <ResolvingAgent navigate={navigate} />;
  }

  const terminalSurface = resolveAgentTerminalSurface(agent);
  const relayKey = terminalSurface
    ? `${terminalSurface.backend}:${agent.id}:${terminalSurface.sessionName}:${mode ?? "takeover"}`
    : `takeover:${agentId}:${mode ?? "takeover"}`;

  return (
    <TerminalTakeoverGate
      key={relayKey}
      agentId={agentId}
      agent={agent}
      mode={mode}
      navigate={navigate}
    >
      <TerminalRelayCanvas
        agentId={agentId}
        agent={agent}
        mode={mode}
        navigate={navigate}
      />
    </TerminalTakeoverGate>
  );
}

/** @deprecated Use {@link TerminalContent} with a terminal route. */
export function TerminalScreen({
  agentId,
  mode,
  terminalSessionId,
  terminalSurfaceKey,
  navigate,
}: TerminalScreenProps) {
  const route: TerminalRoute = {
    view: "terminal",
    agentId,
    mode,
    terminalSessionId,
    terminalSurfaceKey,
  };
  return <TerminalContent route={route} navigate={navigate} />;
}
