import type { CSSProperties } from "react";
import {
  AttentionList,
  AudioSettings,
  Composer,
  ConnectionChip,
  DeckStandby,
  HostScopeBar,
  LaneIdentity,
  LaneRow,
  LaneStream,
  PhaseLine,
  PrimaryKey,
  RebindKey,
  RefreshKey,
  SettingsKey,
  StopKey,
  TaskBinding,
  ViewTabs,
  VoiceCaption,
  VoiceOutKey,
  VoiceTrace,
} from "../deck-parts.tsx";
import { connectionReadout, shortId, voiceReadout } from "../deck-controller.ts";
import type { DeckModel } from "../deck-controller.ts";
import "./deck-console.css";

/**
 * Console — a fleet board with a single glareshield.
 *
 * The interaction model is simultaneous and pointed: every lane is visible and
 * one tap away, and the operator works by direct selection rather than
 * navigation. The critique that status was fragmented is answered structurally:
 * one command bar spans the surface and carries connection, binding, lifecycle
 * and every turn control, so nothing about *now* lives anywhere else.
 */
export function DeckConsole({ model }: { model: DeckModel }) {
  const lane = model.selected;

  return (
    <div className="console">
      <header className="console__bar">
        <div className="console__bar-status">
          <ConnectionChip model={model} />
          <TaskBinding model={model} size="md" />
        </div>
        <PhaseLine model={model} compact />
        <div className="console__bar-controls">
          <StopKey model={model} />
          <RebindKey model={model} />
          <RefreshKey model={model} />
          <VoiceOutKey model={model} />
          <SettingsKey model={model} />
          <PrimaryKey model={model} size="md" />
        </div>
      </header>

      <div className="console__body">
        <aside className="console__bank" aria-label="Agent lanes">
          <div className="console__panel-head">
            <span className="deck-kicker">Lanes</span>
            <span className="deck-kicker">{model.activeCount} live / {model.scopedLanes.length}</span>
          </div>
          <div className="console__lanes">
            {model.scopedLanes.map((item, index) => (
              <LaneRow key={item.key} lane={item} index={index} model={model} />
            ))}
            {model.scopedLanes.length === 0 ? <p className="deck-empty-note">No lanes in this scope.</p> : null}
          </div>
          <HostScopeBar model={model} />
        </aside>

        <section className="console__stage">
          {lane ? (
            <>
              <div className="console__stage-head">
                <LaneIdentity model={model} />
                <div className="console__meter" aria-label="Lane activity over the last five minutes">
                  <small>5m</small>
                  <div aria-hidden="true">
                    {model.laneActivity.map((level, index) => (
                      <i key={index} style={{ "--level": level } as CSSProperties} />
                    ))}
                  </div>
                  <small>now</small>
                </div>
              </div>

              <div className="console__viewport">
                <div className="console__panel-head">
                  <ViewTabs model={model} />
                  <span className="deck-kicker">{lane.hostName} / {lane.id}</span>
                </div>
                <div className="console__viewport-body">
                  <LaneStream model={model} limit={12} />
                </div>
              </div>

              <div className="console__dock">
                <VoiceTrace model={model} />
                <VoiceCaption model={model} />
                <Composer model={model} rows={2} />
              </div>
            </>
          ) : (
            <DeckStandby model={model} />
          )}
        </section>

        <aside className="console__rail" aria-label="Session readout">
          <div className="console__panel-head">
            <span className="deck-kicker">Readout</span>
            <span className="deck-kicker">{model.preview ? "Sample" : model.adapterAvailable ? "Native" : "—"}</span>
          </div>
          <dl className="console__readout">
            <div><dt>Source</dt><dd>{model.preview ? "sample data" : "paired host"}</dd></div>
            <div><dt>Bridge</dt><dd>{connectionReadout(model.connection)}</dd></div>
            <div>
              <dt>Session</dt>
              <dd>{model.thread?.threadId ? shortId(model.thread.threadId) : model.sessionBusy ? "starting" : model.adapterAvailable ? "disconnected" : "—"}</dd>
            </div>
            <div><dt>Turn</dt><dd>{model.thread?.turnId ? shortId(model.thread.turnId) : "none"}</dd></div>
            <div><dt>Voice in</dt><dd>{model.voiceAvailable ? voiceReadout(model.voice.input.state) : "—"}</dd></div>
            <div>
              <dt>Voice out</dt>
              <dd>{model.voiceOutputAvailable ? model.voice.output.speaking ? "speaking" : model.voiceOutEnabled ? "armed" : "off" : "—"}</dd>
            </div>
            <div><dt>Queue</dt><dd title={model.thread?.capabilityNotes.queue}>{model.adapterAvailable ? "off" : "—"}</dd></div>
            <div><dt>Approval</dt><dd title={model.thread?.capabilityNotes.approvals}>{model.adapterAvailable ? "off" : "—"}</dd></div>
          </dl>

          <div className="console__panel-head">
            <span className="deck-kicker">Attention</span>
            <span className="deck-kicker">{String(model.attention.length).padStart(2, "0")}</span>
          </div>
          <AttentionList model={model} />

          <div className="console__panel-head">
            <span className="deck-kicker">Fleet</span>
            <span className="deck-kicker">{String(model.hosts.length).padStart(2, "0")}</span>
          </div>
          <div className="console__fleet">
            {model.hosts.map((host) => (
              <div className="console__fleet-row" key={host.id}>
                <i data-state={host.state} />
                <span>
                  <strong>{host.name}</strong>
                  <small>{model.lanes.filter((item) => item.hostId === host.id).length} lanes</small>
                </span>
                <em>{host.state}</em>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <AudioSettings model={model} />
    </div>
  );
}
