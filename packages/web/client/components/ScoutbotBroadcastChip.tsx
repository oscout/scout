import type { MouseEvent as ReactMouseEvent } from "react";
import { Bot, Loader2 } from "lucide-react";

import { toggleScoutbot } from "../lib/scoutbot-broadcast-store.ts";
import {
  useScoutbotState,
  type ScoutbotActivity,
} from "../scout/scoutbot/ScoutbotStateContext.tsx";
import { useContextMenu, type MenuItem } from "./ContextMenu.tsx";

import "./scoutbot-broadcast-chip.css";

type ChipSurface =
  | { kind: "activity"; activity: ScoutbotActivity; label: string }
  | { kind: "idle" };

function activityLabel(activity: ScoutbotActivity): string {
  switch (activity) {
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "briefing":
      return "thinking";
    case "idle":
    default:
      return "";
  }
}

function activityShowsSpinner(activity: ScoutbotActivity): boolean {
  return activity === "thinking" || activity === "briefing";
}

function resolveSurface(activity: ScoutbotActivity): ChipSurface {
  if (activity !== "idle") {
    return {
      kind: "activity",
      activity,
      label: activityLabel(activity),
    };
  }
  return { kind: "idle" };
}

function buildTitle(surface: ChipSurface, sessionTitle: string | null, error: string | null): string {
  const lines: string[] = [];
  switch (surface.kind) {
    case "activity":
      lines.push(`Scout · ${surface.label}`);
      break;
    case "idle":
    default:
      lines.push("Toggle Scout");
      break;
  }
  if (sessionTitle) lines.push(sessionTitle);
  if (error) lines.push(error);
  return lines.join("\n");
}

export function ScoutbotBroadcastChip() {
  const { state, actions } = useScoutbotState();
  const showContextMenu = useContextMenu();
  const surface = resolveSurface(state.activity);
  const title = buildTitle(surface, state.session.title, state.error);

  const variantClass = (() => {
    switch (surface.kind) {
      case "activity":
        return "s-scoutbot-chip--activity";
      case "idle":
      default:
        return "s-scoutbot-chip--idle";
    }
  })();

  const handlePrimaryClick = () => {
    toggleScoutbot();
  };

  const openQuickMenu = (event: ReactMouseEvent) => {
    const items: MenuItem[] = [
      { kind: "action", label: "New chat", onSelect: () => actions.startNewChat() },
      {
        kind: "action",
        label: state.voice.replies ? "Turn voice replies off" : "Turn voice replies on",
        onSelect: () => actions.toggleVoiceReplies(),
      },
      { kind: "separator" },
      { kind: "action", label: "Open chat", onSelect: () => actions.focusScoutbot() },
    ];
    showContextMenu(event, items);
  };

  return (
    <button
      type="button"
      className={`s-scoutbot-chip ${variantClass}`}
      onClick={handlePrimaryClick}
      onContextMenu={openQuickMenu}
      title={title}
    >
      <Bot size={14} className="s-scoutbot-chip-icon" aria-hidden="true" />
      {surface.kind === "activity" && (
        <>
          {activityShowsSpinner(surface.activity) ? (
            <Loader2 size={10} className="s-scoutbot-chip-spinner" aria-hidden="true" />
          ) : (
            <span className="s-scoutbot-chip-dot s-scoutbot-chip-dot--pulse" aria-hidden="true" />
          )}
          <span className="s-scoutbot-chip-text">{surface.label}</span>
        </>
      )}
    </button>
  );
}
