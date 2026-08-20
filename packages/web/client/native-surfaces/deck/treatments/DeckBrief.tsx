import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioSettings,
  ChevronIcon,
  Composer,
  ConnectionChip,
  DeckStandby,
  LaneStream,
  PhaseLine,
  PrimaryKey,
  StopIcon,
  ViewTabs,
  VoiceCaption,
  VoiceOutKey,
  VoiceTrace,
} from "../deck-parts.tsx";
import { laneStateLabel, laneTone, shortId, taskTitle, transportLabel } from "../deck-controller.ts";
import type { DeckModel } from "../deck-controller.ts";
import "./deck-brief.css";

type BriefCommand = {
  id: string;
  group: "Turn" | "Session" | "Lanes" | "Audio" | "Layout";
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
};

/**
 * Brief — one column, one session, one palette.
 *
 * The interaction model is sequential: there is no peripheral chrome to scan,
 * so the transcript gets the whole width and the largest type on the Deck.
 * Everything that is not reading happens through a single command surface,
 * opened by the dock's Commands key or ⌘K, which also carries lane navigation.
 * Nothing is hidden that is needed continuously — binding, lifecycle and the
 * primary voice key stay pinned above and below the reading column.
 */
export function DeckBrief({ model }: { model: DeckModel }) {
  const [paletteOpen, setPaletteOpen] = useState(
    () => model.preview && new URLSearchParams(window.location.search).get("palette") === "open",
  );
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const queryRef = useRef<HTMLInputElement | null>(null);
  const lane = model.selected;

  const commands = useMemo<BriefCommand[]>(() => {
    const list: BriefCommand[] = [
      {
        id: "start-codex",
        group: "Session",
        label: model.sessionBusy ? "Starting Codex for this workspace" : "Start Codex for this workspace",
        disabled: !model.canStartCodexSession,
        run: () => void model.startCodexSession(),
      },
      {
        id: "talk",
        group: "Turn",
        label: model.voice.input.state === "listening" ? "Stop dictation and send" : "Talk to this session",
        hint: model.phase === "running" ? "steers the running turn" : "starts a turn",
        disabled: !model.canTalk,
        run: () => void model.toggleVoiceInput(),
      },
      {
        id: "send",
        group: "Turn",
        label: model.phase === "running" ? "Steer with composer text" : "Send composer text",
        hint: "⌘↵",
        disabled: !model.canCompose || !model.command.trim(),
        run: () => void model.submitTurn(model.command),
      },
      {
        id: "stop",
        group: "Turn",
        label: "Interrupt the running turn",
        disabled: !model.canInterrupt || model.threadBusy,
        run: () => void model.interruptThread(),
      },
      {
        id: "bind",
        group: "Session",
        label: model.phase === "failed" ? "Retry the Codex connection" : "Reconnect the Codex session",
        disabled: !model.canRebind || model.threadBusy,
        run: () => void model.connectThread(),
      },
      {
        id: "refresh",
        group: "Session",
        label: "Re-read the session snapshot",
        disabled: !model.canRefresh,
        run: () => void model.refreshSnapshot(),
      },
      {
        id: "view",
        group: "Session",
        label: model.view === "thread" ? "Show lane signal" : "Show session turns",
        run: () => model.setView(model.view === "thread" ? "signal" : "thread"),
      },
      {
        id: "voice-out",
        group: "Audio",
        label: model.voiceOutEnabled ? "Mute spoken replies" : "Speak replies aloud",
        disabled: !model.voiceOutputAvailable,
        run: () => void model.toggleVoiceOutput(),
      },
      {
        id: "stop-speaking",
        group: "Audio",
        label: "Stop speaking now",
        disabled: !model.voice.output.speaking,
        run: () => void model.stopSpeaking(),
      },
      {
        id: "auto-send",
        group: "Audio",
        label: model.autoSendOnStop ? "Keep transcript in composer instead of sending" : "Send when dictation stops",
        run: model.toggleAutoSend,
      },
      {
        id: "audio",
        group: "Audio",
        label: "Open audio and dictation settings",
        run: () => model.setSettingsOpen(true),
      },
      {
        id: "ops",
        group: "Layout",
        label: "Switch to Ops (routed agent controller)",
        run: () => model.setTreatment("ops"),
      },
      {
        id: "yoke",
        group: "Layout",
        label: "Switch to Yoke (two-grip cockpit)",
        run: () => model.setTreatment("yoke"),
      },
      {
        id: "console",
        group: "Layout",
        label: "Switch to Console (fleet board)",
        run: () => model.setTreatment("console"),
      },
    ];
    for (const [index, item] of model.scopedLanes.entries()) {
      list.push({
        id: `lane-${item.key}`,
        group: "Lanes",
        label: `${String(index + 1).padStart(2, "0")} · ${item.name}`,
        hint: `${item.hostName} · ${laneStateLabel(item.state).toLowerCase()}`,
        run: () => model.selectLane(item),
      });
    }
    for (const host of model.hosts) {
      list.push({
        id: `scope-${host.id}`,
        group: "Lanes",
        label: `Scope to ${host.name}`,
        hint: host.state,
        disabled: host.state !== "connected",
        run: () => model.selectHostScope(host.id),
      });
    }
    if (model.hosts.length > 1) {
      list.push({
        id: "scope-all",
        group: "Lanes",
        label: "Scope to all hosts",
        run: () => model.selectHostScope("all"),
      });
    }
    return list;
  }, [model]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const usable = commands.filter((command) => !command.disabled);
    if (!needle) return usable;
    return usable.filter((command) => `${command.group} ${command.label} ${command.hint ?? ""}`.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    setCursor(0);
  }, [query, paletteOpen]);

  useEffect(() => {
    if (paletteOpen) queryRef.current?.focus();
  }, [paletteOpen]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuery("");
        setPaletteOpen((open) => !open);
        return;
      }
      if (!paletteOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setPaletteOpen(false);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((current) => {
          if (matches.length === 0) return 0;
          const next = current + (event.key === "ArrowDown" ? 1 : -1);
          return (next + matches.length) % matches.length;
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const command = matches[cursor];
        if (!command) return;
        command.run();
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, matches, cursor]);

  if (!lane) {
    return <div className="brief brief--standby"><DeckStandby model={model} /></div>;
  }

  const title = taskTitle(model.thread);
  const bound = Boolean(model.thread?.threadId);

  return (
    <div className="brief">
      <div className="brief__column">
        <header className="brief__head">
          <div className="brief__head-top">
            <ConnectionChip model={model} />
            <div className="brief__head-keys">
              <VoiceOutKey model={model} />
              <button type="button" className="brief__jump" onClick={() => { setQuery(""); setPaletteOpen(true); }}>
                <span>{String(model.selectedIndex + 1).padStart(2, "0")} / {String(model.scopedLanes.length).padStart(2, "0")} lanes</span>
                <ChevronIcon dir="down" />
              </button>
            </div>
          </div>
          {/* In Brief the Codex session is the subject of the page, so its exact
              title is the heading and the lane is the kicker above it. */}
          <span className="deck-kicker brief__kicker" data-bound={bound || undefined}>
            {!model.adapterAvailable
              ? model.sessionBusy ? "Starting Codex" : "Codex session not started"
              : bound ? "Scout Codex session" : "No session connected"} · {lane.name} · {lane.hostName}
          </span>
          <h2>{bound ? title ?? "Untitled session" : lane.name}</h2>
          <p className="brief__meta">
            {model.thread?.threadId ? `id ${shortId(model.thread.threadId)}` : "id —"}
            {model.thread?.turnId ? ` · turn ${shortId(model.thread.turnId)}` : ""}
            {" · "}{lane.projectRoot ?? "project unavailable"}
            {" · "}{lane.model ?? "default model"}
            {" · "}{transportLabel(lane.transport)}
          </p>
          <PhaseLine model={model} />
        </header>

        <div className="brief__viewport">
          <div className="brief__viewport-head">
            <ViewTabs model={model} />
            {model.canInterrupt ? (
              <button
                type="button"
                className="deck-stop"
                onClick={model.interruptThread}
                disabled={model.threadBusy || model.phase === "stopping"}
              >
                <StopIcon />
                <span>{model.phase === "stopping" ? "Stopping" : "Stop turn"}</span>
              </button>
            ) : null}
          </div>
          <div className="brief__viewport-body">
            <LaneStream model={model} limit={14} />
          </div>
        </div>

        <div className="brief__dock">
          <div className="brief__dock-voice">
            <PrimaryKey model={model} size="lg" />
            <div className="brief__dock-trace">
              <VoiceTrace model={model} />
              <VoiceCaption model={model} />
            </div>
            <button
              type="button"
              className="brief__commands"
              onClick={() => { setQuery(""); setPaletteOpen(true); }}
              aria-haspopup="dialog"
            >
              Commands<em>⌘K</em>
            </button>
          </div>
          <Composer model={model} rows={2} />
        </div>
      </div>

      {paletteOpen ? (
        <div className="brief__palette-scrim" onClick={() => setPaletteOpen(false)}>
          <div
            className="brief__palette"
            role="dialog"
            aria-label="Deck commands"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              ref={queryRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Run a command or jump to a lane…"
              aria-label="Filter commands"
            />
            <div className="brief__palette-list">
              {matches.length === 0 ? <p className="deck-empty-note">Nothing matches, and nothing was run.</p> : null}
              {matches.map((command, index) => (
                <button
                  type="button"
                  key={command.id}
                  data-active={index === cursor || undefined}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => { command.run(); setPaletteOpen(false); }}
                >
                  <span className="brief__palette-group" data-tone={command.group === "Lanes" ? laneGroupTone(model, command.id) : undefined}>
                    {command.group}
                  </span>
                  <strong>{command.label}</strong>
                  {command.hint ? <em>{command.hint}</em> : null}
                </button>
              ))}
            </div>
            <footer>↑↓ move · ↵ run · esc close</footer>
          </div>
        </div>
      ) : null}

      <AudioSettings model={model} />
    </div>
  );
}

function laneGroupTone(model: DeckModel, commandId: string): string | undefined {
  const key = commandId.replace(/^lane-/, "");
  const lane = model.scopedLanes.find((item) => item.key === key);
  return lane ? laneTone(lane) : undefined;
}
