import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ScoutbotActivity =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "briefing";

export type ScoutbotReminderSummary = {
  id: string;
  body: string;
  status: "scheduled" | "due" | "dismissed";
  dueAt: number;
};

export type ScoutbotPublicState = {
  activity: ScoutbotActivity;
  brief: {
    lastDeliveredAt: number | null;
  };
  reminders: {
    dueCount: number;
    upcomingCount: number;
    due: ScoutbotReminderSummary[];
    next: ScoutbotReminderSummary | null;
  };
  voice: {
    available: boolean | null;
    setupBlocked: boolean;
    replies: boolean;
  };
  error: string | null;
  session: {
    title: string | null;
    lastActivityAt: number | null;
  };
  /**
   * SCO-085: conversation emptiness/loading exposed ABOVE the right panel so
   * the shell can auto-collapse empty CONTEXT without mounting panel children
   * (collapsed SidePanel unmounts them — direct /ops/lanes must not deadlock).
   */
  conversation: {
    messageCount: number;
    loading: boolean;
  };
};

export type ScoutbotActionApi = {
  focusScoutbot: () => void;
  triggerBrief: () => void;
  triggerAskState: () => void;
  toggleVoiceReplies: () => void;
  openScoutbotSettings: () => void;
  startNewChat: () => void;
  dismissReminder: (id: string) => void;
  askReminderStatus: (reminder: { id: string; body: string }) => void;
};

export const DEFAULT_SCOUTBOT_STATE: ScoutbotPublicState = {
  activity: "idle",
  brief: { lastDeliveredAt: null },
  reminders: { dueCount: 0, upcomingCount: 0, due: [], next: null },
  voice: { available: null, setupBlocked: false, replies: false },
  error: null,
  session: { title: null, lastActivityAt: null },
  conversation: { messageCount: 0, loading: true },
};

const noop = () => {};

const DEFAULT_SCOUTBOT_ACTIONS: ScoutbotActionApi = {
  focusScoutbot: noop,
  triggerBrief: noop,
  triggerAskState: noop,
  toggleVoiceReplies: noop,
  openScoutbotSettings: noop,
  startNewChat: noop,
  dismissReminder: noop,
  askReminderStatus: noop,
};

type ScoutbotStateContextValue = {
  state: ScoutbotPublicState;
  actions: ScoutbotActionApi;
  publishState: (next: ScoutbotPublicState) => void;
  registerActions: (next: ScoutbotActionApi) => void;
};

const ScoutbotStateContext = createContext<ScoutbotStateContextValue | null>(null);

export function ScoutbotStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ScoutbotPublicState>(DEFAULT_SCOUTBOT_STATE);
  const actionsRef = useRef<ScoutbotActionApi>(DEFAULT_SCOUTBOT_ACTIONS);

  const publishState = useCallback((next: ScoutbotPublicState) => {
    setState((prev) => (scoutbotStateEqual(prev, next) ? prev : next));
  }, []);

  const registerActions = useCallback((next: ScoutbotActionApi) => {
    actionsRef.current = next;
  }, []);

  const stableActions = useMemo<ScoutbotActionApi>(
    () => ({
      focusScoutbot: () => actionsRef.current.focusScoutbot(),
      triggerBrief: () => actionsRef.current.triggerBrief(),
      triggerAskState: () => actionsRef.current.triggerAskState(),
      toggleVoiceReplies: () => actionsRef.current.toggleVoiceReplies(),
      openScoutbotSettings: () => actionsRef.current.openScoutbotSettings(),
      startNewChat: () => actionsRef.current.startNewChat(),
      dismissReminder: (id) => actionsRef.current.dismissReminder(id),
      askReminderStatus: (reminder) => actionsRef.current.askReminderStatus(reminder),
    }),
    [],
  );

  const value = useMemo<ScoutbotStateContextValue>(
    () => ({ state, actions: stableActions, publishState, registerActions }),
    [state, stableActions, publishState, registerActions],
  );

  return (
    <ScoutbotStateContext.Provider value={value}>
      {children}
    </ScoutbotStateContext.Provider>
  );
}

export function useScoutbotState(): {
  state: ScoutbotPublicState;
  actions: ScoutbotActionApi;
} {
  const ctx = useContext(ScoutbotStateContext);
  if (!ctx) {
    return { state: DEFAULT_SCOUTBOT_STATE, actions: DEFAULT_SCOUTBOT_ACTIONS };
  }
  return { state: ctx.state, actions: ctx.actions };
}

export function useScoutbotStatePublisher(): {
  publishState: (next: ScoutbotPublicState) => void;
  registerActions: (next: ScoutbotActionApi) => void;
} | null {
  const ctx = useContext(ScoutbotStateContext);
  if (!ctx) return null;
  return { publishState: ctx.publishState, registerActions: ctx.registerActions };
}

function scoutbotStateEqual(a: ScoutbotPublicState, b: ScoutbotPublicState): boolean {
  return (
    a.activity === b.activity &&
    a.brief.lastDeliveredAt === b.brief.lastDeliveredAt &&
    a.reminders.dueCount === b.reminders.dueCount &&
    a.reminders.upcomingCount === b.reminders.upcomingCount &&
    reminderListEqual(a.reminders.due, b.reminders.due) &&
    reminderSummaryEqual(a.reminders.next, b.reminders.next) &&
    a.voice.available === b.voice.available &&
    a.voice.setupBlocked === b.voice.setupBlocked &&
    a.voice.replies === b.voice.replies &&
    a.error === b.error &&
    a.session.title === b.session.title &&
    a.session.lastActivityAt === b.session.lastActivityAt &&
    a.conversation.messageCount === b.conversation.messageCount &&
    a.conversation.loading === b.conversation.loading
  );
}

function reminderListEqual(
  a: ScoutbotReminderSummary[],
  b: ScoutbotReminderSummary[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!reminderSummaryEqual(a[i], b[i])) return false;
  }
  return true;
}

function reminderSummaryEqual(
  a: ScoutbotReminderSummary | null,
  b: ScoutbotReminderSummary | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.status === b.status &&
    a.dueAt === b.dueAt
  );
}
