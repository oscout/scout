import type * as ReactModule from "react";
import type {
  CSSProperties,
  ComponentType,
  MouseEvent,
  ReactNode,
} from "react";

// Keep Bun's runtime resolver away from this repo's React -> .d.ts tsconfig path.
// @ts-expect-error -- untyped relative .js import, cast back to React's public type.
const React = (await import("../../../node_modules/react/index.js")) as typeof ReactModule;
const { createElement, useCallback, useEffect, useState } = React;

export type StatusColor = "emerald" | "amber" | "red" | "neutral";

export type CommandOption = {
  id: string;
  label: string;
  action?: () => void;
  shortcut?: string;
  keywords?: string[];
};

export type TakeoverState = {
  active: boolean;
  dismissible?: boolean;
  onDismiss?: () => void;
};

export type AppIntent = {
  commandId: string;
  title: string;
  description?: string;
  category?: string;
  keywords?: string[];
  shortcut?: string;
  params?: Array<{
    name: string;
    description?: string;
    type: string;
  }>;
};

export type HudsonApp = {
  id: string;
  name: string;
  description?: string;
  mode: "panel" | "canvas" | "focus" | string;
  icon?: ReactNode;
  Provider: ComponentType<{ children: ReactNode }>;
  leftPanel?: {
    title?: string;
    icon?: ReactNode;
    headerActions?: ComponentType;
  };
  rightPanel?: {
    title?: string;
    icon?: ReactNode;
    headerActions?: ComponentType;
  };
  slots: {
    Content: ComponentType;
    LeftPanel?: ComponentType;
    RightPanel?: ComponentType;
    Inspector?: ComponentType;
    Takeover?: ComponentType;
    Terminal?: ComponentType;
  };
  tools?: Array<{
    id: string;
    name: string;
    icon?: ReactNode;
    Component: ComponentType;
  }>;
  intents?: AppIntent[];
  hooks: {
    useCommands: () => CommandOption[];
    useStatus?: () => { label: string; color: StatusColor };
    useSearch?: () => { value: string; onChange: (value: string) => void; placeholder?: string } | null;
    useNavCenter?: () => ReactNode;
    useNavActions?: () => ReactNode;
    useLayoutMode?: () => "panel" | "canvas" | "focus" | string;
    useActiveToolHint?: () => string | null;
    useTakeover?: () => TakeoverState | null;
  };
};

export type RelayStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type UseTerminalRelayOptions = {
  url: string;
  healthUrl?: string;
  autoConnect?: boolean;
  sessionKey?: string;
  [key: string]: unknown;
};

export type TerminalRelayHandle = {
  status: RelayStatus;
  sessionId: string | null;
  error: string | null;
  exitCode: number | null;
  cwd: string;
  setCwd: (cwd: string) => void;
  onData: (handler: (data: string) => void) => () => void;
  sendInput: (value: string) => void;
  sendLine: (value: string) => void;
  resize: (columns: number, rows: number) => void;
  connect: () => void;
  disconnect: () => void;
  restart: () => void;
};

export function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) as T : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

export function usePlatform() {
  const onInteractiveMouseDown = useCallback((_event: MouseEvent) => {}, []);
  return {
    apiBaseUrl: "",
    serviceApiUrl: "",
    titleBarInset: 0,
    dragRegionProps: {},
    onInteractiveMouseDown,
  };
}

export function usePlatformLayout() {
  return {
    navTotalHeight: 48,
    statusBarHeight: 28,
    panelTopOffset: 48,
  };
}

export function useTerminalRelay(_options: UseTerminalRelayOptions): TerminalRelayHandle {
  return {
    status: "disconnected",
    sessionId: null,
    error: null,
    exitCode: null,
    cwd: "~",
    setCwd: () => {},
    onData: () => () => {},
    sendInput: () => {},
    sendLine: () => {},
    resize: () => {},
    connect: () => {},
    disconnect: () => {},
    restart: () => {},
  };
}

export function TerminalRelay({
  relay,
  quiet,
  configItems,
}: {
  relay: TerminalRelayHandle;
  fontSize?: number;
  quiet?: boolean;
  configItems?: Array<{ label: string; value: string }>;
}) {
  return createElement(
    "div",
    {
      "data-hudson-terminal-relay": "",
      "data-status": relay.status,
      style: { height: "100%", minHeight: 0, background: "#0d0d0d", color: "#d4d4d4" },
    },
    !quiet && configItems?.length
      ? createElement(
          "pre",
          { style: { margin: 0, padding: 8, fontSize: 11 } },
          configItems.map((item) => `${item.label}: ${item.value}`).join("\n"),
        )
      : null,
  );
}

export function Assistant(_props: { app: HudsonApp; commands?: CommandOption[] }) {
  return null;
}

export type CanvasProps = {
  panOffset?: { x: number; y: number };
  scale?: number;
  onPan?: (delta: { x: number; y: number }) => void;
  onZoom?: (scale: number) => void;
  gridOpacity?: number;
  style?: CSSProperties;
};

export function Canvas(props: CanvasProps) {
  return createElement("div", {
    "data-hudson-canvas": "",
    style: { position: "absolute", inset: 0, ...props.style },
  });
}
