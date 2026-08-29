'use client';

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, Maximize2, Minimize2, PanelBottom, PanelRight, Pin, PinOff, Search, Sparkles, Terminal as TerminalIcon, X } from "lucide-react";
import { Assistant, type HudsonApp, type CommandOption, usePersistentState, usePlatform, usePlatformLayout } from "@hudsonkit";
import { CommandDock, Frame, SidePanel, StatusBar } from "@hudsonkit/chrome";
import { FeatureFlagsProvider, useOptionalFlag } from "hudsonkit/flags";
import { ScoutFeatureFlagPanel } from "./components/ScoutFeatureFlagPanel.tsx";
import { ScoutMark } from "./components/ScoutMark.tsx";
import { DevFlagToggle } from "./components/DevFlagToggle.tsx";
import { isScoutDevToolsAvailable } from "./lib/use-scout-dev-flags.ts";
import { CommandPalette, TerminalDrawer } from "@hudsonkit/overlays";

import {
  CanvasMinimapProvider,
  useCanvasMinimap,
} from "./lib/canvas-minimap.tsx";
import {
  SCOUT_AUDIENCE_ORDER,
  SCOUT_DEFAULT_AUDIENCE,
  SCOUT_FLAG_STORAGE_KEY,
  scoutFlagInitialLayers,
  scoutFlags,
} from "./lib/scout-flags.ts";
import { useScopeShellChrome } from "./scope/index.ts";
import { type ScoutStatusBarState, useScoutStatusBarState } from "./scout/hooks.ts";
import { useScout } from "./scout/Provider.tsx";
import { useBrowserLocation } from "./lib/router.ts";
import { KeyboardHelpOverlay, useKeyboardHelp } from "./components/KeyboardHelpOverlay.tsx";
import { PairingRequestPrompt } from "./components/PairingRequestPrompt.tsx";
import {
  ScoutActivityLogOverlay,
  ScoutActivityLogStatusButton,
} from "./components/ScoutActivityLogOverlay.tsx";
import { ScoutbotBroadcastChip } from "./components/ScoutbotBroadcastChip.tsx";
import { ScoutbotRealtimeVoice } from "./scout/scoutbot/ScoutbotRealtimeVoice.tsx";
import { SCOUT_REALTIME_VOICE_FLAG } from "../shared/realtime-voice.ts";
import { useScoutActivityLogBridge } from "./lib/scout-activity-log-bridge.ts";
import {
  isEditableTarget,
  isModalShortcutContext,
  isTerminalFocusShortcut,
  isTerminalInputTarget,
  usePaneNav,
} from "./lib/keyboard-nav.ts";
import {
  isNewChatShortcut,
  NEW_CHAT_SHORTCUT_LABEL,
  NEW_TASK_ACTION_LABEL,
} from "./lib/new-chat-shortcut.ts";
import { goShortcutForKey } from "./lib/go-shortcuts.ts";
import { SidebarProvider } from "./components/ui/sidebar.tsx";
import { ScoutSidebar } from "./scout/sidebar/ScoutSidebar.tsx";
import {
  ScoutSideRail,
  sideRailHasContent,
} from "./scout/sidebar/ScoutSideRail.tsx";
import { CenterPaneHeader } from "./scout/sidebar/CenterPaneHeader.tsx";
import { TopRowIdentity } from "./scout/sidebar/TopRowIdentity.tsx";

import {
  RAIL_COLLAPSED_WIDTH,
  RAIL_HEADER_HEIGHT,
  RAIL_TOGGLE_HEADER_TOP,
  railToggleOffset,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
  SLACK_SIDEBAR_COLLAPSED_WIDTH,
  SIDE_RAIL_DEFAULT_WIDTH,
  SIDE_RAIL_MAX_WIDTH,
  SIDE_RAIL_MIN_WIDTH,
  clampSideRailWidth,
  resolveRailDragCommit,
  resolveRailDragGhostWidth,
  useSidebarCollapse,
} from "./scout/sidebar/useSidebarCollapse.ts";
import { CollapsedRail } from "./scout/sidebar/CollapsedRail.tsx";
import { InspectorCollapsedBody } from "./scout/sidebar/InspectorCollapsedBody.tsx";

import { RailToggle } from "./components/RailToggle.tsx";
import { useScoutbotState } from "./scout/scoutbot/ScoutbotStateContext.tsx";
import {
  isLanesContextEmpty,
  resolveLanesContextCollapsed,
} from "./scout/sidebar/empty-context-collapse.ts";
import { routeHasMeaningfulInspector } from "./scout/sidebar/inspector-visibility.ts";
import { nextRightPanelToggle } from "./scout/sidebar/right-panel-toggle.ts";

interface OpenScoutAppShellProps {
  app: HudsonApp;
  assistant?: boolean;
}

const SIDE_PANEL_MIN_WIDTH = 240;
const SIDE_PANEL_MAX_WIDTH_HARD_CAP = 900;
const SIDE_PANEL_MAX_WIDTH_VIEWPORT_RATIO = 0.45;
const SIDE_PANEL_MAX_WIDTH_FLOOR = 500;
const SEARCH_RIGHT_PANEL_MIN_WIDTH = 420;
// Agent + session detail is a core flow; give it a wider pane when it slides in.
const AGENTS_RIGHT_PANEL_MIN_WIDTH = 480;
const DISPATCH_SHEET_MIN_WIDTH = 520;
const CENTER_CONTENT_MIN_WIDTH = 560;
const GO_SHORTCUT_TIMEOUT_MS = 1500;

// SCO-088b: the app-wide top row is ONE 40px row inset to the sidebar (the study's
// "PERMANENT HORIZONTAL = 40 top · 28 status"). It supersedes the sco-087b two-row
// split: the area title/breadcrumb and the AREA_SUB_NAV tabs sit inline on the same
// row, utilities pinned right, one bottom hairline. Side rail / center / inspector
// all begin below it (contentTopOffset); the three chevrons center in the panel
// header band just under the row (the shared y≈48 band).
/** The single top-row height (study: 40px permanent horizontal). */
const SIDEBAR_TOP_ROW_HEIGHT = 40;

interface ScoutNavigationBarProps {
  title: string;
  center?: React.ReactNode;
  actions?: React.ReactNode;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
}

// Cap at 45% of viewport, floored at 500 so small screens still get usable inspector.
function computeSidePanelMaxWidth(viewportWidth: number) {
  return Math.min(
    SIDE_PANEL_MAX_WIDTH_HARD_CAP,
    Math.max(SIDE_PANEL_MAX_WIDTH_FLOOR, Math.floor(viewportWidth * SIDE_PANEL_MAX_WIDTH_VIEWPORT_RATIO)),
  );
}

function ScoutNavigationBar({ title, center, actions, search }: ScoutNavigationBarProps) {
  const { dragRegionProps, onInteractiveMouseDown } = usePlatform();
  const { navTotalHeight } = usePlatformLayout();
  const isFiltered = Boolean(search?.value);
  const barRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);

  // The center strip shifts itself to stay centered over the content area
  // (see .scout-nav-tabs transform). Publish the real widths of the bar's
  // left/right groups and the strip so the CSS clamp can keep the strip from
  // sliding under either absolutely-positioned side group.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = () => {
      const leftW = (leftRef.current?.offsetWidth ?? 0) + 16;
      const rightW = (rightRef.current?.offsetWidth ?? 0) + 16;
      const stripW = centerRef.current?.firstElementChild?.clientWidth ?? 0;
      bar.style.setProperty("--scout-nav-left-w", `${leftW}px`);
      bar.style.setProperty("--scout-nav-right-w", `${rightW}px`);
      bar.style.setProperty("--scout-nav-strip-w", `${stripW}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    const strip = centerRef.current?.firstElementChild;
    for (const el of [leftRef.current, rightRef.current, strip]) {
      if (el) observer.observe(el);
    }
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div
      ref={barRef}
      data-frame-panel="navigation"
      className="fixed top-0 left-0 right-0 z-50 pointer-events-auto"
      {...dragRegionProps}
    >
      <div
        className="bg-background/95 border-b shadow-[var(--hud-shadow-nav)] flex items-end px-4"
        style={{ height: navTotalHeight, borderColor: "var(--hud-chrome-border, oklch(var(--border) / 0.8))" }}
      >
        <div
          ref={leftRef}
          className="absolute left-4 bottom-0 h-12 z-10 flex items-center gap-2.5 select-none"
          onMouseDown={onInteractiveMouseDown}
        >
          <div
            aria-label={title}
            className="flex items-center gap-2 rounded-sm px-0.5 -mx-0.5 leading-none text-foreground/90"
          >
            {/* Inherits the chrome's own ink instead of a baked cream, and sized
                a step up from the 16px nav icons — the brand should be the
                largest mark in the bar, not the smallest. The glow is dropped
                with the hardcoded colour: a white bloom is a dark-theme effect,
                and on paper it only fogged the mark it was meant to lift. */}
            <ScoutMark className="h-[22px] w-[22px] text-[var(--scout-chrome-ink-strong,currentColor)]" />
            <span className="font-mono text-sm font-medium tracking-[0.06em] leading-none">
              {title}
            </span>
          </div>
        </div>

        {center && (
          <div ref={centerRef} className="flex-1 flex justify-center h-12 items-center" onMouseDown={onInteractiveMouseDown}>
            {center}
          </div>
        )}

        <div ref={rightRef} className="absolute right-4 bottom-0 h-12 z-10 flex items-center gap-3" onMouseDown={onInteractiveMouseDown}>
          {actions}

          {search && (
            <div className="hidden sm:block relative w-[220px] max-w-[34vw] bg-card border border-input rounded px-2.5 shadow-[inset_0_1px_0_oklch(var(--foreground)/0.02)] hover:border-ring/60 focus-within:border-ring focus-within:bg-card transition-colors duration-200">
              <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                placeholder={search.placeholder ?? "Search"}
                className={`
                  w-full h-7 pl-5 pr-6 bg-transparent text-sm font-mono font-normal tracking-[0.02em]
                  placeholder:text-muted-foreground/80 placeholder:font-light text-foreground
                  focus:outline-none transition-all duration-200
                  ${isFiltered ? "text-accent" : ""}
                `}
              />
              {isFiltered && (
                <button
                  type="button"
                  onClick={() => search.onChange("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded-sm"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OpenScoutAppShell({ app, assistant = true }: OpenScoutAppShellProps) {
  return (
    <FeatureFlagsProvider
      registry={scoutFlags}
      audience={SCOUT_DEFAULT_AUDIENCE}
      audienceOrder={SCOUT_AUDIENCE_ORDER}
      storageKey={SCOUT_FLAG_STORAGE_KEY}
      initialLayers={scoutFlagInitialLayers()}
    >
      <app.Provider>
        <CanvasMinimapProvider>
          <OpenScoutAppShellInner app={app} assistantEnabled={assistant} />
        </CanvasMinimapProvider>
      </app.Provider>
    </FeatureFlagsProvider>
  );
}

function OpenScoutStatusBarLeft({
  statusBar,
  dictationActive,
}: {
  statusBar: ScoutStatusBarState;
  dictationActive: boolean;
}) {
  const scoutbotEnabled = useOptionalFlag("surface.scoutbot", true);
  const realtimeVoiceEnabled = useOptionalFlag(SCOUT_REALTIME_VOICE_FLAG, true);
  const meshValueClass = statusBar.mesh.color === "amber"
    ? "text-amber-400"
    : statusBar.mesh.color === "red"
      ? "text-red-400"
      : "text-foreground";

  return (
    <div className="flex items-center gap-3 font-mono leading-none">
      <div className="flex items-center gap-1.5">
        <span className="text-2xs font-normal uppercase tracking-[0.16em] text-muted-foreground">
          {statusBar.mesh.label}
        </span>
        <span className={`text-xs ${meshValueClass}`}>{statusBar.mesh.value}</span>
      </div>
      {(scoutbotEnabled || realtimeVoiceEnabled) && (
        <>
          <span aria-hidden="true" className="select-none text-muted-foreground/40 text-xs">·</span>
          <div className="flex items-center gap-1">
            {scoutbotEnabled && <ScoutbotBroadcastChip />}
            {realtimeVoiceEnabled && (
              <ScoutbotRealtimeVoice dictationActive={dictationActive} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function OpenScoutStatusBarRight({
  statusBar,
  onOpenFlagPanel,
  onOpenActivityLog,
}: {
  statusBar: ScoutStatusBarState;
  onOpenFlagPanel: () => void;
  onOpenActivityLog: () => void;
}) {
  return (
    <div className="flex max-w-[42vw] items-center gap-3">
      <ScoutActivityLogStatusButton onOpen={onOpenActivityLog} />
      <span aria-hidden="true" className="select-none text-muted-foreground/40 text-xs">·</span>
      <DevFlagToggle onOpenPanel={onOpenFlagPanel} />
      <div
        className="truncate font-mono text-xs leading-none text-muted-foreground"
        title={statusBar.build.title}
      >
        {statusBar.build.label}
      </div>
    </div>
  );
}

function OpenScoutAppShellInner({ app, assistantEnabled }: { app: HudsonApp; assistantEnabled: boolean }) {
  const { navTotalHeight } = usePlatformLayout();
  const { titleBarInset, dragRegionProps, onInteractiveMouseDown } = usePlatform();
  const keyboardHelp = useKeyboardHelp();
  usePaneNav();
  const {
    route,
    openContextCapture,
    apiConnection,
    navigate,
    navigateBack,
    selectedBrokerAttempt,
    selectedKnowledgeHit,
    appearanceDetails,
  } = useScout();
  const browserLocation = useBrowserLocation();
  const slackShell = appearanceDetails.shell === "slack";
  // SCO-083: exactly one chrome tree — sidebar experiment vs legacy left panel.
  const sidebarChromeFlag = useOptionalFlag("nav.sidebar", false);
  // Slack is an alternate Scout presentation, not a feature/data mode. It uses
  // the existing sidebar/context/content/inspector modules and requires the
  // multi-column chrome even when the experimental Scout flag is disabled.
  const sidebarChrome = slackShell || sidebarChromeFlag;
  // SCO-085: full-height sidebar — content/panels use titlebar-safe top (0 on web).
  const chromeTopOffset = sidebarChrome ? titleBarInset : navTotalHeight;
  // SCO-087: the slim app-wide top row lives in the sidebar-chrome path only.
  // Everything right of the sidebar starts below it; the legacy top bar path
  // (?ff.nav.sidebar=off) is unaffected and keeps chromeTopOffset = navTotalHeight.
  const topRowActive = sidebarChrome;
  // SCO-088b: ONE 40px top row (title + AREA_SUB_NAV inline). No second row.
  const topRowHeight = topRowActive ? SIDEBAR_TOP_ROW_HEIGHT : 0;
  const contentTopOffset = chromeTopOffset + topRowHeight;
  // SCO-088b: all three chevrons center in the panel header band that begins just
  // below the top row — the shared y≈48 band the study draws (top 40 + 8).
  const railToggleTop = contentTopOffset + RAIL_TOGGLE_HEADER_TOP;
  const scoutbotPublic = useScoutbotState();

  const appCommands = app.hooks.useCommands();
  const appSearch = app.hooks.useSearch?.() ?? null;
  const appNavCenter = app.hooks.useNavCenter?.() ?? null;
  const appNavActions = app.hooks.useNavActions?.() ?? null;
  const layoutMode = app.hooks.useLayoutMode?.() ?? app.mode;
  const frameMode = layoutMode === "focus" ? "panel" : layoutMode;
  const activeToolHint = app.hooks.useActiveToolHint?.() ?? null;
  const takeover = app.hooks.useTakeover?.() ?? null;
  const takeoverActive = takeover?.active === true;
  const takeoverDismissible = takeoverActive && takeover?.dismissible === true;
  const takeoverOnDismiss = takeover?.onDismiss;
  const TakeoverSlot = app.slots.Takeover;
  const statusBar = useScoutStatusBarState();
  useScoutActivityLogBridge(statusBar, apiConnection);
  const canvasMinimap = useCanvasMinimap();
  const [showActivityLog, setShowActivityLog] = useState(false);

  // Legacy left-panel key — kept during soak; sidebar uses its own key.
  const [leftCollapsed, setLeftCollapsed] = usePersistentState(`appshell.${app.id}.left`, false);
  const [rightCollapsed, setRightCollapsed] = usePersistentState(`appshell.${app.id}.right`, false);
  const [rightOverlay, setRightOverlay] = usePersistentState(`appshell.${app.id}.rightOverlay`, false);
  const [leftWidth, setLeftWidth] = usePersistentState(`appshell.${app.id}.leftW`, 260);
  const [rightWidth, setRightWidth] = usePersistentState(`appshell.${app.id}.rightW`, 280);
  const [minimapCollapsed, setMinimapCollapsed] = usePersistentState("openscout.ops.minimap.collapsed", false);
  const [terminalFocus, setTerminalFocus] = usePersistentState(
    `appshell.${app.id}.terminalFocus`,
    false,
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  const [sidePanelMaxWidth, setSidePanelMaxWidth] = useState(() =>
    computeSidePanelMaxWidth(typeof window !== "undefined" ? window.innerWidth : 1280),
  );
  const isSearchRoute = route.view === "search" || browserLocation.pathname === "/search";
  const sidebarCollapsedWidth = slackShell
    ? SLACK_SIDEBAR_COLLAPSED_WIDTH
    : SIDEBAR_COLLAPSED_WIDTH;
  const sidebarCollapse = useSidebarCollapse(
    app.id,
    viewportWidth,
    sidebarCollapsedWidth,
  );
  const terminalFocusActive = sidebarChrome
    && route.view === "terminal"
    && terminalFocus;

  // SCO-088 §3: side-rail ghost-edge resize. The committed width is leftWidth
  // (persisted under the shell's own `leftW` key); during a drag only this ghost
  // target moves, so the center pane + panel box stay pinned and the width
  // commits in a single write on pointer-up (mirrors the sidebar).
  const [sideRailDragWidth, setSideRailDragWidth] = useState<number | null>(null);
  const [sideRailDragStartedCollapsed, setSideRailDragStartedCollapsed] =
    useState(false);
  const sideRailDragTargetRef = useRef<number | null>(null);
  const sidebarDragTargetRef = useRef<number | null>(null);
  const isSideRailResizing = sideRailDragWidth != null;
  // SCO-088b: continuous ghost preview from 48 up to max (drag-through-collapse).
  const sideRailGhostWidth =
    sideRailDragWidth != null
      ? resolveRailDragGhostWidth(sideRailDragWidth, {
          min: SIDE_RAIL_MIN_WIDTH,
          max: SIDE_RAIL_MAX_WIDTH,
          startedCollapsed: sideRailDragStartedCollapsed,
        })
      : null;
  // SCO-088 §2/§3: shared resize-commit "settle ghost" — a 2px accent line left
  // at the committed edge on pointer-up that fades over ~150ms (composited
  // opacity), so the one-write commit reads as a settle rather than a jump.
  const [settleGhostX, setSettleGhostX] = useState<number | null>(null);
  const settleGhostTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      setViewportWidth(window.innerWidth);
      setSidePanelMaxWidth(computeSidePanelMaxWidth(window.innerWidth));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Path-driven Scope presentation — never mutates persisted collapse prefs.
  const { active: scopePresentation, brandLabel: scopeBrandLabel } = useScopeShellChrome({
    route,
  });

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--scout-rail-collapsed-width",
      `${RAIL_COLLAPSED_WIDTH}px`,
    );
    if (sidebarChrome) {
      document.documentElement.setAttribute("data-scout-sidebar-chrome", "");
      document.documentElement.style.setProperty(
        "--scout-nav-rail-width",
        `${sidebarCollapse.width}px`,
      );
      if (sidebarCollapse.isSidebarResizing) {
        document.documentElement.setAttribute("data-scout-sidebar-resizing", "");
      } else {
        document.documentElement.removeAttribute("data-scout-sidebar-resizing");
      }
    } else {
      document.documentElement.removeAttribute("data-scout-sidebar-chrome");
      document.documentElement.removeAttribute("data-scout-sidebar-resizing");
      document.documentElement.style.removeProperty("--scout-nav-rail-width");
    }
    return () => {
      document.documentElement.removeAttribute("data-scout-sidebar-chrome");
      document.documentElement.removeAttribute("data-scout-sidebar-resizing");
      document.documentElement.style.removeProperty("--scout-nav-rail-width");
    };
  }, [sidebarChrome, sidebarCollapse.width, sidebarCollapse.isSidebarResizing]);

  useEffect(() => {
    // SCO-088c (Codex blocker 3): only clamp leftWidth to the side-rail band when
    // sidebar chrome is ON. With ?ff.nav.sidebar=off, leftWidth is the LEGACY left
    // panel width (its own semantics/cap) — clamping+persisting it to 240–400 would
    // truncate legacy widths, so use the legacy clamp there instead.
    if (sidebarChrome) {
      setLeftWidth((current) => clampSideRailWidth(current));
    } else {
      setLeftWidth((current) =>
        Math.min(sidePanelMaxWidth, Math.max(SIDE_PANEL_MIN_WIDTH, current)),
      );
    }
    setRightWidth((current) => Math.min(sidePanelMaxWidth, Math.max(SIDE_PANEL_MIN_WIDTH, current)));
  }, [sidebarChrome, sidePanelMaxWidth, setLeftWidth, setRightWidth]);

  useEffect(() => {
    if (!isSearchRoute || rightCollapsed || rightOverlay) return;
    setRightWidth((current) => Math.max(current, Math.min(sidePanelMaxWidth, SEARCH_RIGHT_PANEL_MIN_WIDTH)));
  }, [isSearchRoute, rightCollapsed, rightOverlay, setRightWidth, sidePanelMaxWidth]);

  // Widen the inspector when an agent's detail slides in — sessions + agent
  // detail are a core flow here and want room to be parsed, not a 280px sliver.
  const agentsV2Peek =
    route.view === "agents-v2"
    && !route.agentId
    && !route.sessionId
    && Boolean(route.selectedAgentId);
  const agentDetailOpen =
    agentsV2Peek
    || (route.view === "agents-v2" && Boolean(route.agentId));
  useEffect(() => {
    if (!agentDetailOpen || rightCollapsed || rightOverlay) return;
    setRightWidth((current) => Math.max(current, Math.min(sidePanelMaxWidth, AGENTS_RIGHT_PANEL_MIN_WIDTH)));
  }, [agentDetailOpen, rightCollapsed, rightOverlay, setRightWidth, sidePanelMaxWidth]);

  const dispatchSheetOpen = route.view === "broker" && Boolean(route.attemptId);
  useEffect(() => {
    if (!dispatchSheetOpen) return;
    setRightCollapsed(false);
    setRightWidth((current) => Math.max(current, Math.min(sidePanelMaxWidth, DISPATCH_SHEET_MIN_WIDTH)));
  }, [dispatchSheetOpen, setRightCollapsed, setRightWidth, sidePanelMaxWidth]);

  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);

  const handlePan = useCallback((delta: { x: number; y: number }) => {
    setPanOffset((prev) => ({ x: prev.x + delta.x, y: prev.y + delta.y }));
  }, []);

  const handleZoom = useCallback((newScale: number) => {
    setScale(newScale);
  }, []);

  const [showTerminal, setShowTerminal] = useState(false);
  const [isTerminalMaximized, setIsTerminalMaximized] = useState(false);
  const [terminalHeight, setTerminalHeight] = usePersistentState(`appshell.${app.id}.termH`, 320);

  const hasTerminalSlot = !!app.slots.Terminal;
  const drawerTabs = useMemo<DrawerTab[]>(() => {
    const tabs: DrawerTab[] = [];
    if (hasTerminalSlot) tabs.push("terminal");
    if (assistantEnabled) tabs.push("assistant");
    return tabs;
  }, [hasTerminalSlot, assistantEnabled]);
  const defaultTab: DrawerTab = drawerTabs[0] ?? "terminal";
  const [activeTab, setActiveTab] = usePersistentState<DrawerTab>(
    `appshell.${app.id}.drawerTab`,
    defaultTab,
  );
  const resolvedTab: DrawerTab = drawerTabs.includes(activeTab) ? activeTab : defaultTab;

  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showFlagPanel, setShowFlagPanel] = useState(false);
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());
  const goShortcutPendingRef = useRef(false);
  const goShortcutTimerRef = useRef<number | null>(null);

  const clearGoShortcut = useCallback(() => {
    goShortcutPendingRef.current = false;
    if (goShortcutTimerRef.current !== null) {
      window.clearTimeout(goShortcutTimerRef.current);
      goShortcutTimerRef.current = null;
    }
  }, []);

  const startGoShortcut = useCallback(() => {
    goShortcutPendingRef.current = true;
    if (goShortcutTimerRef.current !== null) {
      window.clearTimeout(goShortcutTimerRef.current);
    }
    goShortcutTimerRef.current = window.setTimeout(clearGoShortcut, GO_SHORTCUT_TIMEOUT_MS);
  }, [clearGoShortcut]);

  useEffect(() => clearGoShortcut, [clearGoShortcut]);

  const toggleTool = useCallback((id: string) => {
    setOpenTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleResizeStart = useCallback((side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    const setter = side === "left" ? setLeftWidth : setRightWidth;
    const direction = side === "left" ? 1 : -1;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) * direction;
      setter(Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(sidePanelMaxWidth, startWidth + delta)));
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", cleanup);
    };
    const onMouseUp = () => cleanup();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", cleanup);
  }, [leftWidth, rightWidth, setLeftWidth, setRightWidth, sidePanelMaxWidth]);

  // SCO-088c (Codex blocker 5): reduced-motion is reactive so the render can drop
  // ALL live drag overlays (not just the settle ghost) — reduced motion = instant,
  // no moving overlays; the width still commits once on pointer-up.
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // SCO-088 §2/§3: leave a fading settle ghost at a committed rail edge (viewport
  // x). Skipped under reduced motion. Reused by both left-rail handles.
  const triggerRailSettle = useCallback(
    (edgeX: number) => {
      if (reducedMotion) return;
      setSettleGhostX(edgeX);
      if (settleGhostTimerRef.current !== null) {
        window.clearTimeout(settleGhostTimerRef.current);
      }
      settleGhostTimerRef.current = window.setTimeout(() => {
        setSettleGhostX(null);
        settleGhostTimerRef.current = null;
      }, 150);
    },
    [reducedMotion],
  );
  useEffect(
    () => () => {
      if (settleGhostTimerRef.current !== null) {
        window.clearTimeout(settleGhostTimerRef.current);
      }
    },
    [],
  );

  /**
   * SCO-088b §2: shell-level sidebar edge drag — works in BOTH states.
   * Expanded: resize, or drag past the collapse threshold to collapse on pointer-up.
   * Collapsed: drag the edge outward past the travel threshold to re-expand to the
   * remembered width. The committed layout width stays pinned during the drag (only
   * the ghost moves); exactly one commit on pointer-up, via the same state machinery
   * as the chevron (`commitDrag` → `setCollapsed` / persisted width). Not SidebarRail.
   */
  const handleSidebarResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startedCollapsed = sidebarCollapse.effectiveCollapsed;
    const startX = e.clientX;
    const startWidth = startedCollapsed
      ? sidebarCollapsedWidth
      : sidebarCollapse.expandedWidth;
    sidebarDragTargetRef.current = startWidth;
    sidebarCollapse.beginResize(startWidth, startedCollapsed);

    // Nit: one cleanup, shared by up/cancel/blur, so the drag session can never
    // get stuck if the pointer is cancelled or the window loses focus.
    const cleanup = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onPointerCancel);
    };
    const onPointerMove = (ev: PointerEvent) => {
      const raw = startWidth + (ev.clientX - startX);
      sidebarDragTargetRef.current = raw;
      sidebarCollapse.updateResize(raw);
    };
    const onPointerUp = () => {
      const raw = sidebarDragTargetRef.current ?? startWidth;
      const commit = sidebarCollapse.commitDrag(raw, startedCollapsed);
      // Settle at the committed edge (sidebar starts at x=0, so edge x = width).
      const edge =
        commit.kind === "collapse"
          ? sidebarCollapsedWidth
          : commit.kind === "expand"
            ? sidebarCollapse.expandedWidth
            : commit.kind === "resize"
              ? commit.width
              : null;
      if (edge != null) triggerRailSettle(edge);
      cleanup();
    };
    const onPointerCancel = () => {
      // Abort without committing (no width change, no collapse/expand).
      sidebarCollapse.clearDrag();
      cleanup();
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onPointerCancel);
  }, [sidebarCollapse, sidebarCollapsedWidth, triggerRailSettle]);

  /**
   * SCO-088b §2/§3: shell-level side-rail edge drag — ghost-edge, both states,
   * same gesture set as the sidebar. Expanded: resize, or drag past the collapse
   * threshold to collapse. Collapsed: drag out past the travel threshold to
   * re-expand to the remembered width (leftWidth, never overwritten on collapse).
   * The committed width stays pinned during the drag; one commit on pointer-up via
   * the same state machinery as the chevron (setLeftCollapsed / setLeftWidth). The
   * handle lives on the side rail's RIGHT edge — a different edge from the sidebar
   * handle, so the two never fight for the same hit region.
   */
  const handleSideRailResizePointerDown = useCallback(
    (navRailWidth: number, startedCollapsed: boolean) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = startedCollapsed
        ? RAIL_COLLAPSED_WIDTH
        : clampSideRailWidth(leftWidth);
      sideRailDragTargetRef.current = startWidth;
      setSideRailDragWidth(startWidth);
      setSideRailDragStartedCollapsed(startedCollapsed);

      const cleanup = () => {
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("blur", onPointerCancel);
      };
      const onPointerMove = (ev: PointerEvent) => {
        const raw = startWidth + (ev.clientX - startX);
        sideRailDragTargetRef.current = raw;
        setSideRailDragWidth(raw);
      };
      const onPointerUp = () => {
        const raw = sideRailDragTargetRef.current ?? startWidth;
        const commit = resolveRailDragCommit(
          { startedCollapsed, rawWidth: raw },
          { min: SIDE_RAIL_MIN_WIDTH, max: SIDE_RAIL_MAX_WIDTH },
        );
        // Same machinery as the side-rail chevron (leftCollapsed / leftWidth);
        // collapse/expand never overwrite the remembered width.
        if (commit.kind === "collapse") setLeftCollapsed(true);
        else if (commit.kind === "expand") setLeftCollapsed(false);
        else if (commit.kind === "resize") setLeftWidth(commit.width);
        setSideRailDragWidth(null);
        sideRailDragTargetRef.current = null;
        const edge =
          commit.kind === "collapse"
            ? navRailWidth + RAIL_COLLAPSED_WIDTH
            : commit.kind === "expand"
              ? navRailWidth + clampSideRailWidth(leftWidth)
              : commit.kind === "resize"
                ? navRailWidth + commit.width
                : null;
        if (edge != null) triggerRailSettle(edge);
        cleanup();
      };
      const onPointerCancel = () => {
        // Abort without committing.
        setSideRailDragWidth(null);
        sideRailDragTargetRef.current = null;
        cleanup();
      };
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("blur", onPointerCancel);
    },
    [leftWidth, setLeftCollapsed, setLeftWidth, triggerRailSettle],
  );

  const agentsV2Route = route.view === "agents-v2";
  const hasMeaningfulInspector = routeHasMeaningfulInspector(route, {
    hasBrokerAttempt: Boolean(selectedBrokerAttempt),
    hasKnowledgeHit: Boolean(selectedKnowledgeHit),
  });

  // Empty /ops/lanes context is derived above the panel because a collapsed
  // SidePanel unmounts its children. Expanding it sets a route-scoped override,
  // never a permanent preference; every entry point shares toggleRightPanel.
  const lanesContextRoute = route.view === "ops" && route.mode === "lanes";
  const [lanesContextForceOpen, setLanesContextForceOpen] = useState(false);
  const scoutbotConversation = scoutbotPublic.state.conversation;
  const lanesContextEmpty = isLanesContextEmpty(route, scoutbotConversation);
  useEffect(() => {
    if (!lanesContextRoute) setLanesContextForceOpen(false);
  }, [lanesContextRoute]);
  useEffect(() => {
    if (!lanesContextEmpty) setLanesContextForceOpen(false);
  }, [lanesContextEmpty]);
  const baseRightCollapsed = rightCollapsed || scopePresentation;
  const effectiveRightCollapsed = resolveLanesContextCollapsed({
    empty: lanesContextEmpty,
    forceOpen: lanesContextForceOpen,
    baseCollapsed: baseRightCollapsed,
  });
  const showRightPanel = !terminalFocusActive
    && !scopePresentation
    && hasMeaningfulInspector;
  const bottomPanelAvailable = drawerTabs.length > 0;
  const rightPanelAvailable = !scopePresentation && hasMeaningfulInspector;
  const rightPanelExpanded = showRightPanel && !effectiveRightCollapsed;
  const toggleRightPanel = useCallback(() => {
    const next = nextRightPanelToggle({
      available: rightPanelAvailable,
      terminalFocusActive,
      lanesContextRoute,
      lanesContextEmpty,
      lanesContextForceOpen,
      rightCollapsed,
    });
    if (!next) return;
    if (next.terminalFocusActive !== terminalFocusActive) {
      setTerminalFocus(next.terminalFocusActive);
    }
    if (next.lanesContextForceOpen !== lanesContextForceOpen) {
      setLanesContextForceOpen(next.lanesContextForceOpen);
    }
    if (next.rightCollapsed !== rightCollapsed) {
      setRightCollapsed(next.rightCollapsed);
    }
  }, [
    lanesContextEmpty,
    lanesContextForceOpen,
    lanesContextRoute,
    rightCollapsed,
    rightPanelAvailable,
    setRightCollapsed,
    setTerminalFocus,
    terminalFocusActive,
  ]);

  const shellCommands: CommandOption[] = useMemo(() => {
    const toggleLeft = () => {
      if (sidebarChrome) {
        sidebarCollapse.toggleCollapsed();
      } else {
        setLeftCollapsed((collapsed) => !collapsed);
      }
    };
    const commands: CommandOption[] = [
      {
        id: "nav:back",
        label: "Back",
        shortcut: "Cmd+[",
        action: navigateBack,
      },
      {
        id: "shell:toggle-sidebar-b",
        label: "Toggle Sidebar",
        shortcut: "Cmd+B",
        action: toggleLeft,
      },
      {
        id: "shell:toggle-right",
        label: "Toggle Right Panel",
        shortcut: "Cmd+]",
        action: toggleRightPanel,
      },
      {
        id: "shell:toggle-right-overlay",
        label: "Toggle Inspector Overlay",
        shortcut: "Cmd+Shift+]",
        action: () => setRightOverlay((overlay) => !overlay),
      },
      {
        id: "shell:new-session",
        label: NEW_TASK_ACTION_LABEL,
        shortcut: NEW_CHAT_SHORTCUT_LABEL,
        action: () => openContextCapture(),
      },
      {
        id: "shell:toggle-terminal",
        label: "Toggle Terminal",
        shortcut: "Ctrl+`",
        action: () => setShowTerminal((visible) => !visible),
      },
      ...(sidebarChrome && route.view === "terminal"
        ? [{
            id: "shell:terminal-focus",
            label: terminalFocus ? "Exit Terminal Focus" : "Focus Terminal",
            shortcut: "Cmd+Shift+B",
            action: () => setTerminalFocus((focused) => !focused),
          }]
        : []),
      {
        id: "shell:feature-flags",
        label: "Feature Flags",
        shortcut: isScoutDevToolsAvailable() ? "Cmd+Shift+F" : undefined,
        action: () => setShowFlagPanel(true),
      },
    ];
    if (assistantEnabled) {
      commands.push({
        id: "shell:toggle-assistant",
        label: "Toggle Assistant",
        shortcut: "Cmd+J",
        action: () => {
          setActiveTab("assistant");
          setShowTerminal((visible) => !visible || activeTab !== "assistant");
        },
      });
    }
    return commands;
  }, [
    assistantEnabled,
    activeTab,
    openContextCapture,
    navigateBack,
    route,
    setActiveTab,
    setLeftCollapsed,
    setRightOverlay,
    setShowFlagPanel,
    setTerminalFocus,
    sidebarChrome,
    sidebarCollapse,
    terminalFocus,
    toggleRightPanel,
  ]);

  const allCommands = useMemo(() => [...appCommands, ...shellCommands], [appCommands, shellCommands]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        isTerminalFocusShortcut(e)
        && !takeoverActive
        && !keyboardHelp.open
        && !isModalShortcutContext()
        && sidebarChrome
        && route.view === "terminal"
      ) {
        e.preventDefault();
        e.stopPropagation();
        setTerminalFocus((focused) => !focused);
        return;
      }
      if (isTerminalInputTarget(e.target)) return;
      if (takeoverActive || keyboardHelp.open) return;
      const key = e.key.toLowerCase();
      const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
      const typing = isEditableTarget(e.target);
      if (goShortcutPendingRef.current) {
        if (e.key === "Escape" || hasModifier || typing) {
          clearGoShortcut();
        } else {
          const goShortcut = goShortcutForKey(key);
          if (goShortcut) {
            e.preventDefault();
            e.stopPropagation();
            clearGoShortcut();
            navigate(goShortcut.route);
            return;
          } else {
            clearGoShortcut();
          }
        }
      }
      if (!hasModifier && !e.shiftKey && key === "g" && !typing) {
        e.preventDefault();
        e.stopPropagation();
        startGoShortcut();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette(true);
      }
      if (isNewChatShortcut(e)) {
        e.preventDefault();
        openContextCapture();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "[") {
        e.preventDefault();
        navigateBack();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        // Cmd+B remains the primary sidebar toggle. Avoid stealing formatting
        // from editable content.
        if (typing) return;
        e.preventDefault();
        if (sidebarChrome) {
          sidebarCollapse.toggleCollapsed();
        } else {
          setLeftCollapsed((collapsed) => !collapsed);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        if (e.shiftKey) {
          setRightOverlay((overlay) => !overlay);
        } else {
          toggleRightPanel();
        }
      }
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setShowTerminal((visible) => !visible);
      }
      if (assistantEnabled && (e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        setActiveTab("assistant");
        setShowTerminal((visible) => !(visible && resolvedTab === "assistant"));
      }
      if (
        isScoutDevToolsAvailable()
        && (e.metaKey || e.ctrlKey)
        && e.shiftKey
        && !e.altKey
        && e.code === "KeyF"
      ) {
        e.preventDefault();
        e.stopPropagation();
        setShowFlagPanel(true);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    assistantEnabled,
    clearGoShortcut,
    keyboardHelp.open,
    navigateBack,
    navigate,
    openContextCapture,
    resolvedTab,
    route,
    setActiveTab,
    setLeftCollapsed,
    setRightCollapsed,
    setRightOverlay,
    setShowFlagPanel,
    setTerminalFocus,
    sidebarChrome,
    sidebarCollapse,
    startGoShortcut,
    takeoverActive,
    toggleRightPanel,
  ]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ width?: unknown }>).detail;
      const width = typeof detail?.width === "number" ? detail.width : 420;
      setRightCollapsed(false);
      setRightWidth((current) =>
        Math.max(current, Math.min(sidePanelMaxWidth, Math.max(SIDE_PANEL_MIN_WIDTH, width))),
      );
    };
    window.addEventListener("scout:set-inspector-width", handler);
    return () => window.removeEventListener("scout:set-inspector-width", handler);
  }, [setRightCollapsed, setRightWidth, sidePanelMaxWidth]);

  const InspectorSlot = app.slots.Inspector;
  const RightPanelSlot = app.slots.RightPanel;
  const hasTools = app.tools && app.tools.length > 0;

  const rightContent = (
    <>
      {InspectorSlot && <InspectorSlot />}
      {!InspectorSlot && RightPanelSlot && <RightPanelSlot />}
      {hasTools && (
        <div className="border-t border-neutral-700/50">
          {app.tools!.map((tool) => {
            const isOpen = openTools.has(tool.id);
            return (
              <div key={tool.id}>
                <button
                  onClick={() => toggleTool(tool.id)}
                  className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm font-mono tracking-wider uppercase transition-colors hover:bg-white/5 ${
                    activeToolHint === tool.id ? "text-emerald-400" : "text-neutral-300"
                  }`}
                >
                  {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  <span className="text-neutral-400">{tool.icon}</span>
                  <span className="font-bold">{tool.name}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3">
                    <tool.Component />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  const rightFooter = (
    <CommandDock onOpenCommandPalette={() => setShowCommandPalette(true)} />
  );
  const minimapChrome = useMemo(() => ({
    isCollapsed: minimapCollapsed,
    onToggleCollapse: () => setMinimapCollapsed((collapsed) => !collapsed),
  }), [minimapCollapsed, setMinimapCollapsed]);
  const canvasMinimapNode = canvasMinimap ? (
    <div className={`scout-canvas-minimap-shell${minimapCollapsed ? " scout-canvas-minimap-shell--collapsed" : ""}`}>
      {canvasMinimap.render(minimapChrome)}
    </div>
  ) : null;
  const floatingCanvasMinimapNode = canvasMinimap ? (
    <div className={`scout-canvas-minimap-shell scout-canvas-minimap-shell--floating${minimapCollapsed ? " scout-canvas-minimap-shell--collapsed" : ""}`}>
      {canvasMinimap.render(minimapChrome)}
    </div>
  ) : null;

  const backgroundRef = useRef<HTMLDivElement>(null);
  const takeoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = backgroundRef.current;
    if (!el) return;
    if (takeoverActive) {
      el.setAttribute("inert", "");
    } else {
      el.removeAttribute("inert");
    }
  }, [takeoverActive]);

  useEffect(() => {
    if (!takeoverActive) return;
    const el = takeoverRef.current;
    if (el) {
      const firstFocusable = el.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      (firstFocusable ?? el).focus();
    }
    if (!takeoverDismissible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        takeoverOnDismiss?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [takeoverActive, takeoverDismissible, takeoverOnDismiss]);

  // Scope presentation: legacy chrome collapses left/right as derived state
  // (never written to prefs). New sidebar chrome keeps a path-aware Scope model.
  const scopeHidesLegacyLeft = scopePresentation && !sidebarChrome;
  const scopeHidesRight = scopePresentation;

  // Side rail (context SidePanel) only when sidebar chrome is on and the route
  // has resolveSidebarContext content. Scope has no Scout context pane.
  // SCO-086: collapsed side rail reserves RAIL_COLLAPSED_WIDTH (not 0); HIDDEN
  // (inactive / no content) stays 0 — no rail, no toggle. Terminal focus hides it.
  const sideRailActive =
    !terminalFocusActive && sidebarChrome && sideRailHasContent(route, scopePresentation);
  const sideRailPushWidth = sideRailActive
    ? (leftCollapsed ? RAIL_COLLAPSED_WIDTH : leftWidth)
    : 0;

  // SCO-088 §1 (F1): when BOTH left rails are collapsed, mark the shell so the CSS
  // can drop the seam between the two 48px strips and tint the collapsed side rail
  // one step darker than the icon rail (nav vs. context handle, not two sidebars).
  const doubleRailCollapsed =
    sideRailActive && sidebarCollapse.effectiveCollapsed && leftCollapsed;
  useEffect(() => {
    if (doubleRailCollapsed) {
      document.documentElement.setAttribute("data-scout-double-rail", "");
    } else {
      document.documentElement.removeAttribute("data-scout-double-rail");
    }
    return () => document.documentElement.removeAttribute("data-scout-double-rail");
  }, [doubleRailCollapsed]);

  // Sidebar chrome: left inset = nav sidebar width + side-rail width.
  // Nav sidebar always reserves rail width (expanded or 48px icon rail).
  // SCO-086: collapsed side rail / inspector push RAIL_COLLAPSED_WIDTH.
  // Legacy SidePanel still collapses to zero width with a floating expand control.
  // HIDDEN right (scope / no panel / overlay / dispatch sheet) stays 0.
  const leftPushInset = terminalFocusActive
    ? 0
    : sidebarChrome
      ? sidebarCollapse.width + sideRailPushWidth
      : (leftCollapsed || scopeHidesLegacyLeft ? 0 : leftWidth);
  const rightPushInset = terminalFocusActive
    ? 0
    : !showRightPanel || rightOverlay || dispatchSheetOpen || scopeHidesRight
      ? 0
      : effectiveRightCollapsed
        ? (sidebarChrome ? RAIL_COLLAPSED_WIDTH : 0)
        : rightWidth;
  const pushedContentWidth = viewportWidth - leftPushInset - rightPushInset;
  const shouldAutoOverlayPanels =
    layoutMode === "panel" &&
    pushedContentWidth < CENTER_CONTENT_MIN_WIDTH &&
    (leftPushInset > 0 || rightPushInset > 0);
  const autoOverlayRight = shouldAutoOverlayPanels && rightPushInset > 0;
  // Side rail (not the icon nav rail) may overlay when center content is squeezed.
  const autoOverlayLeft =
    shouldAutoOverlayPanels &&
    (sidebarChrome
      ? sideRailPushWidth > 0 &&
        viewportWidth - sidebarCollapse.width - sideRailPushWidth < CENTER_CONTENT_MIN_WIDTH
      : leftPushInset > 0 &&
        viewportWidth - leftPushInset < CENTER_CONTENT_MIN_WIDTH);
  const leftPanelOverlaysContent = autoOverlayLeft;
  const rightPanelOverlaysContent = dispatchSheetOpen || rightOverlay || autoOverlayRight;
  // When the side rail overlays, keep the nav rail inset so content starts after icons.
  const leftInset = leftPanelOverlaysContent
    ? (sidebarChrome ? sidebarCollapse.width : 0)
    : leftPushInset;
  const rightInset = rightPanelOverlaysContent ? 0 : rightPushInset;
  const contentStyle: React.CSSProperties = layoutMode === "panel" ? {
    position: "absolute",
    top: contentTopOffset,
    bottom: 28,
    left: leftInset,
    right: rightInset,
    overflow: "auto",
    // SCO-087: insets commit in a single write — no left/right transition, so the
    // (often heavy) center pane reflows at most once per rail toggle / resize
    // instead of every animation frame. The rail animates its own light subtree.
  } : {};
  // Side panels: start below the top row in sidebar mode (style overrides SidePanel default).
  const panelTopStyle: React.CSSProperties = sidebarChrome
    ? { top: contentTopOffset }
    : {};
  // SCO-088b: the side rail begins BELOW the single 40px top row (same top as the
  // center pane + inspector). The top row is inset to the sidebar and spans over
  // the side-rail column; its own 44px header (with the edge chevron) sits just
  // under the row on the shared band.
  const railTopStyle: React.CSSProperties = sidebarChrome
    ? { top: contentTopOffset }
    : {};
  const shellChromeStyle = {
    display: "contents",
    "--scout-shell-left-inset": `${layoutMode === "panel" ? leftInset : 0}px`,
    "--scout-shell-right-inset": `${layoutMode === "panel" ? rightInset : 0}px`,
    // Side-rail expand control offsets against the nav icon/expanded rail width.
    ...(sidebarChrome
      ? { "--scout-nav-rail-width": `${sidebarCollapse.width}px` }
      : {}),
  } as React.CSSProperties;
  const rightOverlayControlTitle = rightOverlay
    ? "Pin inspector (push content)"
    : autoOverlayRight
      ? "Keep inspector floating when there is room"
      : "Float inspector (overlay content)";
  const panelOverlayStyle = useCallback((side: "left" | "right", sheet = false): React.CSSProperties => ({
    backgroundColor: "rgba(13, 14, 16, 0.72)",
    backdropFilter: "blur(24px) saturate(140%)",
    WebkitBackdropFilter: "blur(24px) saturate(140%)",
    boxShadow: side === "left"
      ? "18px 0 48px -12px rgba(0,0,0,0.7), inset -1px 0 0 0 rgba(255,255,255,0.06)"
      : "-18px 0 48px -12px rgba(0,0,0,0.7), inset 1px 0 0 0 rgba(255,255,255,0.06)",
    ...(sheet ? {
      right: 12,
      bottom: 40,
      borderWidth: 1,
      borderStyle: "solid",
      borderColor: "rgba(255,255,255,0.09)",
      borderRadius: 12,
      boxShadow: "-24px 18px 72px -18px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.025)",
    } : {}),
  }), []);

  return (
    <>
      <div ref={backgroundRef} aria-hidden={takeoverActive ? true : undefined} style={shellChromeStyle}>
        <Frame
          mode={frameMode}
          panOffset={panOffset}
          scale={scale}
          onPan={handlePan}
          onZoom={handleZoom}
          hud={
            <>
              {/* SCO-085: ScoutNavigationBar is conditionally UNMOUNTED in sidebar
                  mode (not CSS-hidden) so duplicate controls/IDs never exist. */}
              {!sidebarChrome ? (
                <ScoutNavigationBar
                  title={scopePresentation ? scopeBrandLabel : app.name}
                  search={scopePresentation ? undefined : (appSearch ?? undefined)}
                  center={appNavCenter}
                  actions={appNavActions}
                />
              ) : null}

              {sidebarChrome ? (
                !terminalFocusActive ? (
                  <>
                    <SidebarProvider
                    open={!sidebarCollapse.effectiveCollapsed}
                    onOpenChange={(open) => sidebarCollapse.setCollapsed(!open)}
                    style={
                      {
                        // Live expanded width (SCO-086 continuous resize).
                        "--sidebar-width": `${sidebarCollapse.expandedWidth}px`,
                        "--sidebar-width-icon": `${sidebarCollapsedWidth}px`,
                        // Full-height: brand at window top (titleBarInset is padding, not offset).
                        "--scout-sidebar-top": "0px",
                      } as React.CSSProperties
                    }
                    data-sidebar-resizing={
                      sidebarCollapse.isSidebarResizing ? "" : undefined
                    }
                  >
                    <ScoutSidebar
                      brandLabel={app.name}
                      presentation={slackShell ? "slack" : "scout"}
                    />
                    </SidebarProvider>

                  {/* One control, both states, in the nav column's own header
                      band: expanded it tucks against the inner edge, collapsed
                      it centres in the rail. It no longer straddles the seam —
                      the seam is the resize handle's, and a control that belongs
                      to neither side belongs to no one. SCO-088c (Codex blocker
                      1): it stays pinned at the committed edge during drag (the
                      ghost line is the live preview). */}
                  <RailToggle
                    side="left"
                    collapsed={sidebarCollapse.effectiveCollapsed}
                    label="Sidebar"
                    onToggle={sidebarCollapse.toggleCollapsed}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="scout-rail-toggle--band"
                    style={{
                      position: "fixed",
                      left: railToggleOffset(
                        sidebarCollapse.width,
                        sidebarCollapse.effectiveCollapsed,
                        sidebarCollapsedWidth,
                      ),
                      top: railToggleTop,
                      zIndex: 46,
                    }}
                  />

                  {/* SCO-088b: shell-level drag handle at the sidebar edge, present
                      in BOTH states (z > 40 so it wins its own edge). Expanded:
                      drag resizes, or past the collapse threshold commits collapse.
                      Collapsed: drag the edge outward past the travel threshold to
                      re-expand to the remembered width. Double-click: reset (expanded)
                      or expand-to-default (collapsed). Not stock SidebarRail. */}
                  <div
                    data-scout-sidebar-resize-handle=""
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={
                      sidebarCollapse.effectiveCollapsed
                        ? "Expand sidebar (drag out)"
                        : "Resize or collapse sidebar"
                    }
                    title={
                      sidebarCollapse.effectiveCollapsed
                        ? "Drag out to expand · double-click to expand"
                        : "Drag to resize · drag in to collapse · double-click to reset"
                    }
                    onPointerDown={handleSidebarResizePointerDown}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      if (sidebarCollapse.effectiveCollapsed) {
                        sidebarCollapse.setExpandedWidth(SIDEBAR_EXPANDED_WIDTH);
                        sidebarCollapse.setCollapsed(false);
                      } else {
                        sidebarCollapse.resetExpandedWidth();
                      }
                    }}
                    onMouseDown={(e) => {
                      // Exempt from native window drag region.
                      e.stopPropagation();
                    }}
                    style={{
                      position: "fixed",
                      left: Math.max(0, sidebarCollapse.width - 3),
                      // Start below the chevron's header band so they never collide.
                      top: contentTopOffset + RAIL_HEADER_HEIGHT,
                      bottom: 28,
                      width: 6,
                      zIndex: 50,
                      cursor: "ew-resize",
                      pointerEvents: "auto",
                      touchAction: "none",
                    }}
                  />

                  {/* SCO-087/088b: ghost edge during drag — the committed width
                      stays pinned (no center-pane relayout); this 2px line previews
                      the target (continuous toward the 48px collapse target when
                      dragged past threshold), and it commits once on pointer-up.
                      Codex blocker 5: suppressed entirely under reduced motion (no
                      moving overlay; the width still commits on pointer-up). */}
                  {!reducedMotion &&
                  sidebarCollapse.isSidebarResizing &&
                  sidebarCollapse.dragGhostWidth != null ? (
                    <div
                      data-scout-sidebar-resize-ghost=""
                      aria-hidden="true"
                      className="scout-sidebar-resize-ghost"
                      style={{
                        position: "fixed",
                        left: sidebarCollapse.dragGhostWidth,
                        top: contentTopOffset,
                        bottom: 28,
                        width: 2,
                        transform: "translateX(-50%)",
                        zIndex: 55,
                        pointerEvents: "none",
                      }}
                    />
                  ) : null}

                  {/* Side rail: per-area context in a LEFT HudsonKit SidePanel.
                      Distinct shell slot from the nav sidebar and legacy LeftPanel. */}
                  {sideRailActive ? (
                    <ScoutSideRail
                      presentation={slackShell ? "slack" : "scout"}
                      navRailWidth={sidebarCollapse.width}
                      isCollapsed={leftCollapsed}
                      onToggleCollapse={() => setLeftCollapsed(!leftCollapsed)}
                      width={leftWidth}
                      style={{
                        ...railTopStyle,
                        ...(leftPanelOverlaysContent ? panelOverlayStyle("left") : {}),
                      }}
                    />
                  ) : null}

                  {/* SCO-088b §2/§3: side-rail edge drag handle on the side rail's
                      RIGHT edge (side-rail/content boundary) — a different edge from
                      the sidebar handle, so each wins hit-testing on its own edge.
                      Present in BOTH states AND in overlay mode (Codex blocker 2:
                      drag-collapse/expand must work at narrow widths too). Sits below
                      the rail header band so it never collides with the chevron. */}
                  {sideRailActive ? (
                    <div
                      data-scout-sidebar-resize-handle=""
                      data-scout-side-rail-resize-handle=""
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={
                        leftCollapsed
                          ? "Expand context rail (drag out)"
                          : "Resize or collapse context rail"
                      }
                      title={
                        leftCollapsed
                          ? "Drag out to expand · double-click to expand"
                          : "Drag to resize · drag in to collapse · double-click to reset"
                      }
                      onPointerDown={handleSideRailResizePointerDown(
                        sidebarCollapse.width,
                        leftCollapsed,
                      )}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        if (leftCollapsed) {
                          setLeftWidth(SIDE_RAIL_DEFAULT_WIDTH);
                          setLeftCollapsed(false);
                        } else {
                          setLeftWidth(SIDE_RAIL_DEFAULT_WIDTH);
                        }
                      }}
                      onMouseDown={(e) => {
                        // Exempt from native window drag region.
                        e.stopPropagation();
                      }}
                      style={{
                        position: "fixed",
                        left: Math.max(
                          0,
                          sidebarCollapse.width +
                            (leftCollapsed ? RAIL_COLLAPSED_WIDTH : leftWidth) -
                            3,
                        ),
                        top: contentTopOffset + RAIL_HEADER_HEIGHT,
                        bottom: 28,
                        width: 6,
                        zIndex: 50,
                        cursor: "ew-resize",
                        pointerEvents: "auto",
                        touchAction: "none",
                      }}
                    />
                  ) : null}

                  {/* SCO-088b §2/§3: ghost edge during the side-rail drag — committed
                      width stays pinned; this 2px line previews the target (continuous
                      toward 48 on collapse-drag, growing from 48 on expand-drag) and
                      commits once on pointer-up. Codex blocker 5: suppressed under
                      reduced motion. */}
                  {!reducedMotion && sideRailActive && isSideRailResizing && sideRailGhostWidth != null ? (
                    <div
                      data-scout-side-rail-resize-ghost=""
                      aria-hidden="true"
                      className="scout-sidebar-resize-ghost"
                      style={{
                        position: "fixed",
                        left: sidebarCollapse.width + sideRailGhostWidth,
                        top: contentTopOffset,
                        bottom: 28,
                        width: 2,
                        transform: "translateX(-50%)",
                        zIndex: 55,
                        pointerEvents: "none",
                      }}
                    />
                  ) : null}

                  {/* SCO-088 §2/§3: shared resize-commit settle ghost — fades at the
                      committed edge so the one-write commit reads as a settle. */}
                  {settleGhostX != null ? (
                    <div
                      data-scout-rail-settle-ghost=""
                      aria-hidden="true"
                      className="scout-sidebar-resize-ghost scout-sidebar-resize-ghost--settle"
                      style={{
                        position: "fixed",
                        left: settleGhostX,
                        top: contentTopOffset,
                        bottom: 28,
                        width: 2,
                        transform: "translateX(-50%)",
                        zIndex: 55,
                        pointerEvents: "none",
                      }}
                    />
                  ) : null}
                  </>
                ) : null
              ) : (
                <>
                  <SidePanel
                    side="left"
                    title={
                      agentsV2Route
                        ? "Browse"
                        : route.view === "agent-info"
                          ? "Projects"
                          : app.leftPanel?.title ?? "Navigation"
                    }
                    icon={app.leftPanel?.icon}
                    isCollapsed={leftCollapsed || scopeHidesLegacyLeft}
                    onToggleCollapse={() => setLeftCollapsed(!leftCollapsed)}
                    width={leftWidth}
                    onResizeStart={handleResizeStart("left")}
                    style={leftPanelOverlaysContent ? panelOverlayStyle("left") : undefined}
                    footer={!leftCollapsed && !scopeHidesLegacyLeft ? canvasMinimapNode : undefined}
                    headerActions={app.leftPanel?.headerActions && <app.leftPanel.headerActions />}
                  >
                    <div data-pane="left" style={{ display: "contents" }}>
                      {app.slots.LeftPanel && <app.slots.LeftPanel />}
                    </div>
                  </SidePanel>

                  {(leftCollapsed || scopeHidesLegacyLeft) ? floatingCanvasMinimapNode : null}
                </>
              )}

              {/* SCO-087: single app-wide top row (sidebar-chrome path only).
                  Right of the full-height sidebar; page title/breadcrumb +
                  secondary nav only. Scope and ⌘K live elsewhere (keyboard /
                  other chrome) — keep this row quiet. Owns the top drag
                  region so frameless/macOS window drag keeps working. */}
              {topRowActive ? (
                <div
                  data-scout-top-row-frame=""
                  className="scout-top-row-frame"
                  // Merge the platform drag-region style INTO ours (macOS sets
                  // -webkit-app-region on style); spreading dragRegionProps raw
                  // would clobber our fixed positioning.
                  // SCO-088b: ONE 40px row inset to the sidebar only — it spans
                  // over the side-rail / center / inspector columns (which begin
                  // below it). The sidebar (brand) still owns the top-left corner.
                  style={{
                    position: "fixed",
                    top: chromeTopOffset,
                    left: terminalFocusActive ? 0 : sidebarCollapse.width,
                    right: 0,
                    height: topRowHeight,
                    zIndex: 30,
                    ...((dragRegionProps as { style?: React.CSSProperties } | undefined)?.style ?? {}),
                  }}
                  {...(Object.fromEntries(
                    Object.entries((dragRegionProps ?? {}) as Record<string, unknown>).filter(
                      ([key]) => key !== "style",
                    ),
                  ) as React.HTMLAttributes<HTMLDivElement>)}
                >
                  <CenterPaneHeader
                    variant="top-row"
                    presentation={slackShell ? "slack" : "scout"}
                    onOpenSearch={() => setShowCommandPalette(true)}
                    rightUtility={(
                      <>
                        <TopRowIdentity presentation={slackShell ? "slack" : "scout"} />
                        {route.view === "terminal" ? (
                          <>
                            <div id="scout-terminal-header-slot" data-scout-terminal-header-slot="" />
                            <button
                              type="button"
                              data-scout-terminal-focus-toggle=""
                              aria-label={terminalFocusActive ? "Exit terminal focus" : "Focus terminal"}
                              aria-pressed={terminalFocusActive}
                              aria-keyshortcuts="Meta+Shift+B Control+Shift+B"
                              title={terminalFocusActive
                                ? "Exit focus (⌘⇧B)"
                                : "Focus terminal (⌘⇧B)"}
                              className={`scout-terminal-focus-toggle${
                                terminalFocusActive ? " scout-terminal-focus-toggle--active" : ""
                              }`}
                              onClick={() => setTerminalFocus((focused) => !focused)}
                            >
                              {terminalFocusActive
                                ? <Minimize2 size={13} strokeWidth={1.8} aria-hidden="true" />
                                : <Maximize2 size={13} strokeWidth={1.8} aria-hidden="true" />}
                            </button>
                          </>
                        ) : null}
                        <span
                          className="scout-top-row-panel-toggles"
                          role="group"
                          aria-label="Layout panels"
                        >
                          <button
                            type="button"
                            data-scout-bottom-panel-toggle=""
                            aria-label={bottomPanelAvailable
                              ? (showTerminal ? "Hide bottom panel" : "Show bottom panel")
                              : "Bottom panel unavailable"}
                            aria-pressed={showTerminal}
                            aria-keyshortcuts="Control+`"
                            title={bottomPanelAvailable
                              ? (showTerminal ? "Hide bottom panel (⌃`)" : "Show bottom panel (⌃`)")
                              : "No bottom panel is available in this app"}
                            className={`scout-top-row-panel-toggle${
                              showTerminal ? " scout-top-row-panel-toggle--active" : ""
                            }`}
                            disabled={!bottomPanelAvailable}
                            onClick={() => setShowTerminal((visible) => !visible)}
                          >
                            <PanelBottom size={14} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            data-scout-right-panel-toggle=""
                            aria-label={rightPanelAvailable
                              ? (rightPanelExpanded ? "Hide right panel" : "Show right panel")
                              : "Right panel unavailable for this view"}
                            aria-pressed={rightPanelExpanded}
                            aria-keyshortcuts="Meta+] Control+]"
                            title={rightPanelAvailable
                              ? (rightPanelExpanded ? "Hide right panel (⌘])" : "Show right panel (⌘])")
                              : "No right panel is available for this view"}
                            className={`scout-top-row-panel-toggle${
                              rightPanelExpanded ? " scout-top-row-panel-toggle--active" : ""
                            }`}
                            disabled={!rightPanelAvailable}
                            onClick={toggleRightPanel}
                          >
                            <PanelRight size={14} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        </span>
                      </>
                    )}
                    onInteractiveMouseDown={onInteractiveMouseDown}
                  />
                </div>
              ) : null}

              {showRightPanel && (() => {
                const inspectorTitle = dispatchSheetOpen
                  ? "Dispatch detail"
                  : agentsV2Route
                    ? "Detail"
                    : app.rightPanel?.title ?? "Inspector";
                // SCO-086: sidebar chrome uses OpenScout CollapsedRail at 48px;
                // legacy path keeps HudsonKit's 0-width floating expand button.
                if (sidebarChrome && effectiveRightCollapsed) {
                  return (
                    <>
                      <CollapsedRail
                        side="right"
                        title={inspectorTitle}
                        onToggle={toggleRightPanel}
                        edgeOffset={0}
                        top={contentTopOffset}
                        style={panelTopStyle}
                        body={(
                          <InspectorCollapsedBody
                            route={route}
                            onExpand={toggleRightPanel}
                          />
                        )}
                      />
                      {/* Same band, same y as the expanded control — mirrored to
                          the inspector's inner (left) edge. */}
                      <RailToggle
                        side="right"
                        collapsed
                        label={inspectorTitle}
                        onToggle={toggleRightPanel}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="scout-rail-toggle--band"
                        style={{
                          position: "fixed",
                          right: railToggleOffset(RAIL_COLLAPSED_WIDTH, true),
                          top: railToggleTop,
                          zIndex: 45,
                        }}
                      />
                    </>
                  );
                }

                return (
                  <>
                    <SidePanel
                      side="right"
                      title={inspectorTitle}
                      icon={app.rightPanel?.icon}
                      isCollapsed={sidebarChrome ? false : effectiveRightCollapsed}
                      onToggleCollapse={sidebarChrome ? undefined : toggleRightPanel}
                      width={rightWidth}
                      onResizeStart={handleResizeStart("right")}
                      floating={rightPanelOverlaysContent}
                      style={{
                        ...panelTopStyle,
                        ...(rightPanelOverlaysContent
                          ? panelOverlayStyle("right", dispatchSheetOpen)
                          : {}),
                      }}
                      footer={rightFooter}
                      headerActions={
                        <>
                          {!dispatchSheetOpen && (
                            <button
                              type="button"
                              onClick={() => setRightOverlay((o) => (autoOverlayRight && !o ? true : !o))}
                              title={rightOverlayControlTitle}
                              aria-label={rightOverlayControlTitle}
                              className="p-1 hover:bg-accent/10 rounded transition-colors text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                              {rightPanelOverlaysContent ? <PinOff size={12} /> : <Pin size={12} />}
                            </button>
                          )}
                          {app.rightPanel?.headerActions && <app.rightPanel.headerActions />}
                        </>
                      }
                    >
                      <div data-pane="right" style={{ display: "contents" }}>
                        {rightContent}
                      </div>
                    </SidePanel>
                    {sidebarChrome && !effectiveRightCollapsed ? (
                      <RailToggle
                        side="right"
                        collapsed={false}
                        label={inspectorTitle}
                        onToggle={toggleRightPanel}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="scout-rail-toggle--band"
                        style={{
                          position: "fixed",
                          right: railToggleOffset(rightWidth, false),
                          top: railToggleTop,
                          zIndex: 45,
                        }}
                      />
                    ) : null}
                  </>
                );
              })()}

              <StatusBar
                status={statusBar.status}
                left={(
                  <OpenScoutStatusBarLeft
                    statusBar={statusBar}
                    dictationActive={scoutbotPublic.state.activity === "listening"}
                  />
                )}
                right={(
                  <OpenScoutStatusBarRight
                    statusBar={statusBar}
                    onOpenFlagPanel={() => setShowFlagPanel(true)}
                    onOpenActivityLog={() => setShowActivityLog(true)}
                  />
                )}
                onToggleTerminal={() => setShowTerminal((visible) => !visible)}
                isTerminalOpen={showTerminal}
              />

              <ScoutActivityLogOverlay
                open={showActivityLog}
                onClose={() => setShowActivityLog(false)}
              />

              <div
                className="pointer-events-none"
                style={{
                  position: "fixed",
                  left: leftInset,
                  right: rightInset,
                  bottom: 0,
                  top: 0,
                  zIndex: 45,
                  // SCO-087: insets commit once (no left/right layout transition).
                  transform: "translateZ(0)",
                }}
              >
                <TerminalDrawer
                  isOpen={showTerminal}
                  onClose={() => setShowTerminal(false)}
                  onToggleMaximize={() => setIsTerminalMaximized((maximized) => !maximized)}
                  isMaximized={isTerminalMaximized}
                  height={Math.min(terminalHeight, window.innerHeight * 0.8)}
                  onHeightChange={(h) => setTerminalHeight(Math.min(h, window.innerHeight * 0.8))}
                  title={(
                    <DrawerTabs
                      tabs={drawerTabs}
                      active={resolvedTab}
                      onSelect={setActiveTab}
                    />
                  )}
                >
                  {showTerminal && resolvedTab === "terminal" && (
                    app.slots.Terminal ? (
                      <app.slots.Terminal />
                    ) : (
                      <div className="p-4 font-mono text-md text-neutral-400">
                        No terminal content
                      </div>
                    )
                  )}
                  {showTerminal && resolvedTab === "assistant" && (
                    <Assistant app={app} commands={appCommands} />
                  )}
                </TerminalDrawer>
              </div>

              <CommandPalette
                isOpen={showCommandPalette}
                onClose={() => setShowCommandPalette(false)}
                commands={allCommands}
              />
            </>
          }
        >
          <div style={contentStyle} className="frame-scrollbar" data-pane="center">
            {/* SCO-087: the breadcrumb / sub-nav seam now lives in the fixed
                app-wide top row above (CenterPaneHeader variant="top-row"), not
                inside the scrolling center pane. */}
            <app.slots.Content />
          </div>
        </Frame>
      </div>
      {takeoverActive && TakeoverSlot ? (
        <div
          ref={takeoverRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, zIndex: 80, outline: "none" }}
        >
          {/* SCO-085: onboarding is outside the inert tree; sidebar drag is covered.
              Equivalent drag strip at the top of the takeover. */}
          <div
            data-scout-takeover-drag-region=""
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: Math.max(28, titleBarInset || 28),
              zIndex: 1,
              ...((dragRegionProps as { style?: React.CSSProperties } | undefined)?.style ?? {}),
            }}
            {...(Object.fromEntries(
              Object.entries((dragRegionProps ?? {}) as Record<string, unknown>).filter(
                ([key]) => key !== "style",
              ),
            ) as React.HTMLAttributes<HTMLDivElement>)}
          />
          <TakeoverSlot />
        </div>
      ) : null}
      <KeyboardHelpOverlay
        open={keyboardHelp.open}
        onClose={() => keyboardHelp.setOpen(false)}
      />
      <ScoutFeatureFlagPanel
        isOpen={showFlagPanel}
        onClose={() => setShowFlagPanel(false)}
        audienceOptions={SCOUT_AUDIENCE_ORDER}
      />
      <PairingRequestPrompt />
    </>
  );
}

type DrawerTab = "terminal" | "assistant";

function DrawerTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: DrawerTab[];
  active: DrawerTab;
  onSelect: (tab: DrawerTab) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5">
      {tabs.map((tab) => {
        const isActive = tab === active;
        const Icon = tab === "terminal" ? TerminalIcon : Sparkles;
        const label = tab === "terminal" ? "TERMINAL" : "ASSISTANT";
        const accent = tab === "terminal" ? "text-emerald-400" : "text-cyan-400";
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onSelect(tab)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-bold tracking-widest font-mono transition-colors ${
              isActive ? `${accent} bg-white/[0.04]` : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            <Icon size={13} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
