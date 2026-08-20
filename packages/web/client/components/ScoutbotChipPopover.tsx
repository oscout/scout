import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Bell,
  Bot,
  CheckCircle2,
  ListChecks,
  Loader2,
  Plus,
  Radio,
  Settings,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { formatClockTimestamp } from "../lib/time.ts";
import {
  DEFAULT_MUTE,
  dismissPromotedBroadcast,
  selectActiveBroadcast,
  shouldDisplayBroadcast,
  tierAllowed,
  toggleScoutbot,
  updateMute,
  useScoutbotBroadcastStore,
  type MuteFilter,
  type MuteState,
} from "../lib/scoutbot-broadcast-store.ts";
import {
  useScoutbotState,
  type ScoutbotActivity,
} from "../scout/scoutbot/ScoutbotStateContext.tsx";
import type { Broadcast, BroadcastTier } from "../lib/types.ts";

import "./scoutbot-chip-popover.css";

const MUTE_30M_MS = 30 * 60_000;
const HISTORY_RENDER_LIMIT = 10;

function activityLabel(activity: ScoutbotActivity): string {
  switch (activity) {
    case "listening":
      return "Listening";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "briefing":
      return "Briefing";
    case "idle":
    default:
      return "Idle";
  }
}

function formatHms(ts: number): string {
  return formatClockTimestamp(ts) || "—";
}

function tierDotClass(tier: BroadcastTier): string {
  return `s-scoutbot-popover-dot s-scoutbot-popover-dot--${tier}`;
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="s-scoutbot-popover-section">
      <header className="s-scoutbot-popover-section-head">
        <span>{title}</span>
        {trailing}
      </header>
      <div className="s-scoutbot-popover-section-body">{children}</div>
    </section>
  );
}

function MuteButton({
  label,
  active,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`s-scoutbot-popover-mute-btn${active ? " s-scoutbot-popover-mute-btn--active" : ""}`}
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

export function ScoutbotChipPopover({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { state, actions } = useScoutbotState();
  const snap = useScoutbotBroadcastStore();
  const active = selectActiveBroadcast(snap);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const recentBroadcasts = useMemo<Broadcast[]>(() => {
    return [...snap.history]
      .reverse()
      .filter((b) => tierAllowed(b.tier, snap.mute.filter))
      .slice(0, HISTORY_RENDER_LIMIT);
  }, [snap.history, snap.mute.filter]);

  if (!open) return null;

  const mute: MuteState = snap.mute ?? DEFAULT_MUTE;
  const muteCountdownMs = mute.muteUntil > snap.now ? mute.muteUntil - snap.now : 0;
  const muteCountdownLabel = muteCountdownMs > 0
    ? `${Math.ceil(muteCountdownMs / 60_000)}m left`
    : null;

  const setFilter = (filter: MuteFilter) => {
    updateMute({ ...mute, filter, goDark: false });
  };
  const toggleMute30m = () => {
    if (mute.muteUntil > snap.now) {
      updateMute({ ...mute, muteUntil: 0 });
    } else {
      updateMute({ ...mute, muteUntil: snap.now + MUTE_30M_MS, goDark: false });
    }
  };
  const toggleGoDark = () => {
    updateMute({ ...mute, goDark: !mute.goDark });
  };

  const handleOpenChat = () => {
    toggleScoutbot(active ?? null);
    onClose();
  };

  const handleAction = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const dueReminders = state.reminders.due;
  const hasError = Boolean(state.error);
  const showBriefFresh =
    state.brief.lastDeliveredAt !== null &&
    snap.now - state.brief.lastDeliveredAt <= 5 * 60_000;

  return (
    <>
      <div
        className="s-scoutbot-popover-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        className="s-scoutbot-popover"
        role="dialog"
        aria-label="Scout"
      >
        <header className="s-scoutbot-popover-head">
          <span className="s-scoutbot-popover-head-title">
            {state.session.title ?? "Chat"}
          </span>
          <button
            type="button"
            className="s-scoutbot-popover-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={12} />
          </button>
        </header>

        <Section title="Now">
          {hasError ? (
            <div className="s-scoutbot-popover-now s-scoutbot-popover-now--error">
              <span className="s-scoutbot-popover-dot s-scoutbot-popover-dot--error" />
              <span>{state.error}</span>
            </div>
          ) : state.activity !== "idle" ? (
            <div className="s-scoutbot-popover-now s-scoutbot-popover-now--activity">
              <span className="s-scoutbot-popover-dot s-scoutbot-popover-dot--pulse" />
              <span>{activityLabel(state.activity)}</span>
            </div>
          ) : active ? (
            <div className="s-scoutbot-popover-now">
              <span className={tierDotClass(active.tier)} />
              <span className="s-scoutbot-popover-now-text">{active.text}</span>
              <span className="s-scoutbot-popover-now-time">{formatHms(active.ts)}</span>
              <button
                type="button"
                className="s-scoutbot-popover-now-dismiss"
                onClick={dismissPromotedBroadcast}
                title="Dismiss"
                aria-label="Dismiss"
              >
                <X size={11} />
              </button>
            </div>
          ) : showBriefFresh && state.brief.lastDeliveredAt ? (
            <div className="s-scoutbot-popover-now">
              <span className="s-scoutbot-popover-dot s-scoutbot-popover-dot--info" />
              <span>
                Brief delivered {Math.max(1, Math.floor((snap.now - state.brief.lastDeliveredAt) / 60_000))}m ago
              </span>
            </div>
          ) : (
            <div className="s-scoutbot-popover-empty-line">No active signal.</div>
          )}
        </Section>

        {dueReminders.length > 0 && (
          <Section
            title="Reminders"
            trailing={<span className="s-scoutbot-popover-count">{dueReminders.length}</span>}
          >
            {dueReminders.map((reminder) => (
              <div key={reminder.id} className="s-scoutbot-popover-reminder">
                <Bell size={11} className="s-scoutbot-popover-reminder-icon" aria-hidden="true" />
                <span className="s-scoutbot-popover-reminder-body" title={reminder.body}>
                  {reminder.body}
                </span>
                <button
                  type="button"
                  className="s-scoutbot-popover-icon-btn"
                  onClick={handleAction(() => actions.askReminderStatus({ id: reminder.id, body: reminder.body }))}
                  title="Run status"
                  aria-label="Run status"
                >
                  <Radio size={11} />
                </button>
                <button
                  type="button"
                  className="s-scoutbot-popover-icon-btn"
                  onClick={() => actions.dismissReminder(reminder.id)}
                  title="Dismiss"
                  aria-label="Dismiss"
                >
                  <CheckCircle2 size={11} />
                </button>
              </div>
            ))}
          </Section>
        )}

        <Section
          title="Recent broadcasts"
          trailing={<span className="s-scoutbot-popover-count">{snap.history.length}</span>}
        >
          {recentBroadcasts.length === 0 ? (
            <div className="s-scoutbot-popover-empty-line">No broadcasts.</div>
          ) : (
            <div className="s-scoutbot-popover-history">
              {recentBroadcasts.map((b) => {
                const dimmed = !shouldDisplayBroadcast(b, mute, snap.now);
                return (
                  <div
                    key={b.id}
                    className={`s-scoutbot-popover-history-row${dimmed ? " s-scoutbot-popover-history-row--muted" : ""}`}
                    title={b.text}
                  >
                    <span className={tierDotClass(b.tier)} aria-hidden="true" />
                    <span className="s-scoutbot-popover-history-time">{formatHms(b.ts)}</span>
                    <span className="s-scoutbot-popover-history-text">{b.text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        <Section title="Actions">
          <div className="s-scoutbot-popover-actions">
            <button
              type="button"
              className="s-scoutbot-popover-action"
              onClick={handleAction(actions.triggerBrief)}
            >
              <ListChecks size={11} />
              <span>Brief me now</span>
            </button>
            <button
              type="button"
              className="s-scoutbot-popover-action"
              onClick={handleAction(actions.triggerAskState)}
            >
              <Radio size={11} />
              <span>Run state</span>
            </button>
            <button
              type="button"
              className="s-scoutbot-popover-action"
              onClick={actions.toggleVoiceReplies}
              aria-pressed={state.voice.replies}
            >
              {state.voice.replies ? <Volume2 size={11} /> : <VolumeX size={11} />}
              <span>{state.voice.replies ? "Voice on" : "Voice off"}</span>
            </button>
            <button
              type="button"
              className="s-scoutbot-popover-action"
              onClick={handleAction(actions.openScoutbotSettings)}
            >
              <Settings size={11} />
              <span>Settings</span>
            </button>
            <button
              type="button"
              className="s-scoutbot-popover-action"
              onClick={handleAction(actions.startNewChat)}
            >
              <Plus size={11} />
              <span>New chat</span>
            </button>
            <button
              type="button"
              className="s-scoutbot-popover-action s-scoutbot-popover-action--primary"
              onClick={handleOpenChat}
            >
              <Bot size={11} />
              <span>Open chat</span>
            </button>
          </div>
        </Section>

        <footer className="s-scoutbot-popover-alerts">
          <span className="s-scoutbot-popover-alerts-label">Alerts</span>
          <MuteButton
            label="All"
            active={mute.filter === "all" && !mute.goDark}
            onClick={() => setFilter("all")}
          />
          <MuteButton
            label="Warn+"
            active={mute.filter === "warn-plus" && !mute.goDark}
            onClick={() => setFilter("warn-plus")}
          />
          <MuteButton
            label="Errors"
            active={mute.filter === "errors-only" && !mute.goDark}
            onClick={() => setFilter("errors-only")}
          />
          <MuteButton
            label={muteCountdownLabel ? `Mute ${muteCountdownLabel}` : "Mute 30m"}
            active={muteCountdownMs > 0}
            title={muteCountdownLabel ?? "Suppress for 30 minutes"}
            onClick={toggleMute30m}
          />
          <MuteButton
            label="Go dark"
            active={mute.goDark}
            title="Suppress until toggled off"
            onClick={toggleGoDark}
          />
        </footer>
      </div>
    </>
  );
}
