import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  AudioSettings,
  ChevronIcon,
  ConnectionChip,
  LinkIcon,
  MicIcon,
  PhaseLine,
  PrimaryKey,
  RefreshIcon,
  SlidersIcon,
  SpeakerIcon,
  StopIcon,
  VoiceCaption,
  VoiceTrace,
} from "../deck-parts.tsx";
import {
  blockDetail,
  blockTitle,
  composerPlaceholder,
  laneStateLabel,
  laneTone,
  primaryKeyDescription,
  relativeTime,
  shortId,
  taskTitle,
  threadRows,
  transportLabel,
  turnPhaseLabel,
  voiceReadout,
} from "../deck-controller.ts";
import type { DeckLane, DeckModel } from "../deck-controller.ts";
import "./deck-ops.css";

type OpsFeedEntry = {
  id: string;
  at: number;
  channel: number;
  lane: DeckLane;
  text: string;
  detail: string;
};

type OpsConsoleRow = {
  id: string;
  label: string;
  text: string;
  detail: string;
  at: number | null;
  live: boolean;
};

/**
 * Ops — a Scout-native reinterpretation of the Lattices Fleet Deck.
 *
 * The reference's strongest product idea is machine-as-channel. Scout's
 * controllable unit is more precise: one agent lane on one host. The surface
 * therefore keeps the channel strip, routed dictation bar, focused console,
 * fleet feed and command bay, but every lamp and key is backed by the native
 * Scout/Codex app-server surface contract.
 */
export function DeckOps({ model }: { model: DeckModel }) {
  const lane = model.selected;
  const channel = lane ? model.scopedLanes.findIndex((item) => item.key === lane.key) + 1 : 0;
  const feed = useMemo<OpsFeedEntry[]>(
    () => model.scopedLanes
      .flatMap((item, index) => item.events.map((event) => ({
        id: `${item.key}:${event.id}`,
        at: event.at,
        channel: index + 1,
        lane: item,
        text: event.text,
        detail: event.detail ?? "",
      })))
      .sort((a, b) => b.at - a.at)
      .slice(0, 16),
    [model.scopedLanes],
  );
  const consoleRows = useMemo<OpsConsoleRow[]>(() => {
    if (!lane) return [];
    if (model.view === "signal" || !model.thread) {
      return lane.events.slice(0, 5).reverse().map((event) => ({
        id: event.id,
        label: event.kind.toUpperCase(),
        text: event.text,
        detail: event.detail ?? "",
        at: event.at,
        live: laneTone(lane) === "live" && event.id === lane.events[0]?.id,
      }));
    }
    return threadRows(model.thread, 5).map((row) => ({
      id: row.block.id,
      label: row.role === "operator"
        ? "YOU"
        : row.block.type === "action"
          ? "RUN"
          : row.block.type === "reasoning"
            ? "THINK"
            : "CX",
      text: blockTitle(row.block),
      detail: blockDetail(row.block),
      at: row.at,
      live: row.status === "streaming",
    }));
  }, [lane, model.thread, model.view]);

  const connectedHosts = model.hosts.filter((host) => host.state === "connected");
  const scopeSequence = ["all", ...connectedHosts.map((host) => host.id)];
  const scopeIndex = Math.max(0, scopeSequence.indexOf(model.hostScope));
  const nextScope = scopeSequence[(scopeIndex + 1) % Math.max(1, scopeSequence.length)] ?? "all";
  const scopeLabel = model.hostScope === "all"
    ? "All hosts"
    : model.hosts.find((host) => host.id === model.hostScope)?.name ?? model.hostScope;

  if (!lane) {
    return (
      <div className="ops ops--standby">
        <div className="ops__standby">
          <ConnectionChip model={model} />
          <strong>No agent channels are available</strong>
          <p>{model.error ?? "Waiting for a connected host to publish its Scout lanes."}</p>
        </div>
      </div>
    );
  }

  const boundTitle = taskTitle(model.thread);
  const connectionLabel = model.connection === "ready"
    ? "ONLINE"
    : model.connection === "partial"
      ? "DEGRADED"
      : model.connection.toUpperCase();
  const controlTruth = model.preview
    ? "SIMULATED"
    : model.sessionBusy
      ? "STARTING CODEX"
    : !model.adapterAvailable
      ? model.canStartCodexSession ? "READY TO START" : "VIEW ONLY"
      : model.thread?.threadId && (model.connection === "ready" || model.connection === "partial")
        ? "LIVE"
        : model.connection === "ready" || model.connection === "partial"
          ? "SESSION OFFLINE"
          : "OFFLINE";
  const controlsLabel = model.preview
    ? "8 SIMULATED CONTROLS"
    : model.connection === "ready" || model.connection === "partial"
      ? "8 HOST CONTROLS"
      : "CONTROLS OFFLINE";

  return (
    <div className="ops">
      <section className="ops__channels" aria-label="Agent channels">
        {model.scopedLanes.map((item, index) => (
          <OpsChannel
            key={item.key}
            lane={item}
            index={index}
            active={item.key === lane.key}
            model={model}
          />
        ))}
      </section>

      <section className="ops__voice" aria-label="Routed voice control">
        <PrimaryKey model={model} size="md" />
        <VoiceTrace model={model} />
        <div className="ops__voice-copy">
          <strong>{primaryKeyDescription(
            model.primaryAction,
            model.phase,
            model.voice.input.state,
            model.sessionStartUnavailableReason,
          ).toUpperCase()}</strong>
          <VoiceCaption model={model} />
        </div>
        <div className="ops__routes" role="group" aria-label="Route dictation to agent channel">
          <span>ROUTE TO</span>
          <div>
            {model.scopedLanes.map((item, index) => (
              <button
                key={item.key}
                type="button"
                data-active={item.key === lane.key || undefined}
                onClick={() => model.selectLane(item)}
                aria-pressed={item.key === lane.key}
              >
                CH {index + 1}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="ops__enclosure">
        <header className="ops__enclosure-head">
          <span className="ops__host">
            <i data-tone={model.phaseTone} />
            {lane.hostName}
          </span>
          <span className="ops__binding">
            {model.adapterAvailable ? "SCOUT APP-SERVER" : transportLabel(lane.transport).toUpperCase()}
            <i>·</i>
            {boundTitle ?? lane.projectRoot ?? "NO SESSION"}
          </span>
        </header>

        <div className="ops__workspace">
          <article className="ops__console">
            <header>
              <span>agent console</span>
              <strong data-tone={model.phaseTone}>{turnPhaseLabel(model.phase, lane.state)}</strong>
            </header>

            <div className="ops__agent-line">
              <h2>{lane.name}</h2>
              <span>CH {String(channel).padStart(2, "0")} · {lane.hostName.toUpperCase()}</span>
            </div>
            <p className="ops__task" title={boundTitle ?? undefined}>
              {boundTitle ?? (model.adapterAvailable ? "No Codex session connected" : model.sessionBusy ? "Starting Codex for this workspace…" : "Start Codex to control this workspace")}
            </p>
            <PhaseLine model={model} compact />

            <div className="ops__console-rows" data-view={model.view}>
              {consoleRows.length > 0 ? consoleRows.map((row) => (
                <div key={row.id} className="ops__console-row" data-live={row.live || undefined}>
                  <i />
                  <span>{row.label}</span>
                  <p>
                    <strong>{row.text}</strong>
                    {row.detail ? <small>{row.detail}</small> : null}
                  </p>
                  <time>{relativeTime(row.at)}</time>
                </div>
              )) : (
                <p className="ops__empty">No {model.view === "thread" ? "session turns" : "lane signal"} reported yet.</p>
              )}
            </div>

            <form className="ops__composer" onSubmit={model.onComposerSubmit}>
              <span aria-hidden="true">›</span>
              <input
                value={model.command}
                onChange={(event) => model.setCommand(event.target.value)}
                placeholder={composerPlaceholder(model.phase, model.voice.input.state)}
                disabled={!model.canCompose}
                aria-label={model.phase === "running" ? "Steer the active Codex turn" : "Start a Codex turn"}
              />
              <button type="submit" disabled={!model.canCompose || !model.command.trim()}>
                {model.phase === "running" ? "Steer" : "Send"}
              </button>
            </form>

            <div className="ops__console-actions">
              {model.canRebind ? (
                <button type="button" onClick={model.connectThread} disabled={model.threadBusy}>
                  <LinkIcon />{model.phase === "failed" ? "Retry link" : "Reconnect"}
                </button>
              ) : null}
              <button type="button" onClick={model.refreshSnapshot} disabled={!model.canRefresh}>
                <RefreshIcon />Re-read
              </button>
              {model.canInterrupt ? (
                <button type="button" className="ops__danger" onClick={model.interruptThread} disabled={model.threadBusy}>
                  <StopIcon />{model.phase === "stopping" ? "Stopping" : "Stop turn"}
                </button>
              ) : null}
            </div>

            <footer>
              <span>MODEL <strong>{lane.model ?? "DEFAULT"}</strong></span>
              <span>CONTROL <strong>{controlTruth}</strong></span>
              <span title={model.thread?.threadId ?? undefined}>SESSION <strong>{model.thread?.threadId ? shortId(model.thread.threadId) : "—"}</strong></span>
            </footer>
          </article>

          <aside className="ops__feed">
            <header>
              <span>fleet feed</span>
              <strong>{model.hostScope === "all" ? "ALL HOSTS" : scopeLabel.toUpperCase()} · {feed.length} EVENTS</strong>
            </header>
            <div className="ops__feed-rows">
              {feed.length > 0 ? feed.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-active={entry.lane.key === lane.key || undefined}
                  data-tone={laneTone(entry.lane)}
                  onClick={() => model.selectLane(entry.lane)}
                  aria-label={`Channel ${entry.channel}, ${entry.lane.name}: ${entry.text}`}
                >
                  <time>{relativeTime(entry.at)}</time>
                  <span>CH {entry.channel}</span>
                  <strong>{entry.lane.name.toUpperCase()}</strong>
                  <p>
                    {entry.text}
                    {entry.detail ? <small>{entry.detail}</small> : null}
                  </p>
                </button>
              )) : <p className="ops__empty">No fleet activity reported yet.</p>}
            </div>
          </aside>
        </div>
      </section>

      <section className="ops__commands" aria-label="Deck commands">
        <header>
          <span>COMMANDS</span>
          <strong>{controlsLabel}</strong>
        </header>
        <div className="ops__command-grid">
          <OpsCommand
            ordinal="01"
            label={model.primaryAction === "start_codex" ? "Start Codex" : "Voice"}
            meta={model.primaryAction === "start_codex" ? model.sessionBusy ? "Starting" : "Workspace" : voiceReadout(model.voice.input.state)}
            icon={model.primaryAction === "start_codex" ? <LinkIcon /> : <MicIcon />}
            active={model.voiceInputActive}
            disabled={model.primaryAction === "start_codex"
              ? !model.canStartCodexSession
              : model.primaryAction === "connect"
                ? model.threadBusy
                : !model.canTalk}
            onClick={model.onPrimary}
          />
          <OpsCommand
            ordinal="02"
            label="Session turns"
            meta="Codex session"
            glyph="◎"
            active={model.view === "thread"}
            disabled={!model.adapterAvailable}
            onClick={() => model.setView("thread")}
          />
          <OpsCommand
            ordinal="03"
            label="Lane signal"
            meta="Scout tail"
            glyph="≋"
            active={model.view === "signal"}
            onClick={() => model.setView("signal")}
          />
          <OpsCommand
            ordinal="04"
            label="Re-read"
            meta="Session snapshot"
            icon={<RefreshIcon />}
            disabled={!model.canRefresh}
            onClick={() => void model.refreshSnapshot()}
          />
          <OpsCommand
            ordinal="05"
            label={model.voiceOutEnabled ? "Voice out" : "Muted"}
            meta={model.voice.output.speaking ? "Speaking" : model.voiceOutEnabled ? "Armed" : "Off"}
            icon={<SpeakerIcon />}
            active={model.voiceOutEnabled}
            disabled={!model.voiceOutputAvailable}
            onClick={() => void model.toggleVoiceOutput()}
          />
          <OpsCommand
            ordinal="06"
            label="Audio"
            meta="Dictation"
            icon={<SlidersIcon />}
            active={model.settingsOpen}
            onClick={() => model.setSettingsOpen(!model.settingsOpen)}
          />
          <OpsCommand
            ordinal="07"
            label="Host scope"
            meta={scopeLabel}
            glyph="⌾"
            disabled={scopeSequence.length < 2}
            onClick={() => model.selectHostScope(nextScope)}
          />
          <OpsCommand
            ordinal="08"
            label="Next lane"
            meta={`${channel} / ${model.scopedLanes.length}`}
            icon={<ChevronIcon dir="right" />}
            disabled={model.scopedLanes.length < 2}
            onClick={() => model.stepLane(1)}
          />
        </div>
      </section>

      <footer className="ops__status">
        <span className="ops__status-online" data-connection={model.connection}>
          <i />{connectionLabel}
        </span>
        <span>{lane.hostName}</span>
        <span>ROUTE <strong>CH {channel}</strong></span>
        {model.attention.length > 0 ? <span className="ops__status-attn">ATTN {model.attention.length}</span> : null}
        <span>HOSTS <strong>{model.hosts.length}</strong></span>
        <span>LIVE <strong>{model.activeCount}</strong></span>
        <span>VIEW · <strong>OPS</strong></span>
      </footer>

      <AudioSettings model={model} />
    </div>
  );
}

function OpsChannel({
  lane,
  index,
  active,
  model,
}: {
  lane: DeckLane;
  index: number;
  active: boolean;
  model: DeckModel;
}) {
  const latest = lane.events[0];
  const tone = active && model.phaseTone !== "quiet" ? model.phaseTone : laneTone(lane);
  return (
    <button
      type="button"
      className="ops-channel"
      data-active={active || undefined}
      data-tone={tone}
      onClick={() => model.selectLane(lane)}
      aria-pressed={active}
      aria-label={`Channel ${index + 1}, ${lane.name}, ${laneStateLabel(lane.state)}`}
    >
      <span className="ops-channel__head">
        <small>CH {String(index + 1).padStart(2, "0")}</small>
        <em aria-hidden="true">▰</em>
        <strong>{lane.hostName}</strong>
        <i />
        <small>{active ? turnPhaseLabel(model.phase, lane.state) : laneStateLabel(lane.state)}</small>
      </span>
      <span className="ops-channel__rule" />
      <span className="ops-channel__identity">
        <strong>{lane.name}</strong>
        <small>{lane.harness ?? "agent"} · {lane.model ?? "default"}</small>
      </span>
      <span className="ops-channel__task">{latest?.text ?? lane.projectRoot ?? "No recent activity"}</span>
      <span className="ops-channel__signal">
        <i />
        <small>{latest?.detail || (active ? "controller selected" : "tap to put on deck")}</small>
        <time>{relativeTime(latest?.at ?? lane.updatedAt)}</time>
      </span>
      <span className="ops-channel__foot">
        <strong><i />{active ? "ON DECK" : "TAP TO SWITCH"}</strong>
        <small>{transportLabel(lane.transport).toUpperCase()}</small>
      </span>
    </button>
  );
}

function OpsCommand({
  ordinal,
  label,
  meta,
  glyph,
  icon,
  active,
  disabled = false,
  onClick,
}: {
  ordinal: string;
  label: string;
  meta: string;
  glyph?: string;
  icon?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ops-command"
      data-active={active || undefined}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active == null ? undefined : active}
      title={`${label} · ${meta}`}
    >
      <span className="ops-command__icon">{icon ?? glyph}</span>
      <span>
        <strong>{label}</strong>
        <small>{ordinal} · {meta.toUpperCase()}</small>
      </span>
    </button>
  );
}
