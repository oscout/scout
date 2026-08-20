import {
  AttentionList,
  AudioSettings,
  ChevronIcon,
  Composer,
  ConnectionChip,
  DeckStandby,
  HostScopeBar,
  LaneActivity,
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
import { laneStateLabel, laneTone, transportLabel, transportShortLabel } from "../deck-controller.ts";
import type { DeckModel } from "../deck-controller.ts";
import "./deck-yoke.css";

/**
 * Yoke — a two-grip cockpit for landscape iPad.
 *
 * The interaction model is positional rather than pointed: both hands stay on
 * fixed edges. The left grip holds every action that changes the turn, sized so
 * a thumb never has to aim. The right grip holds every fact about the session
 * in one column, so status is read in a single place. Lanes are *stepped*
 * through, not picked out of a grid, which is why there is no lane bank at all.
 */
export function DeckYoke({ model }: { model: DeckModel }) {
  const lane = model.selected;
  if (!lane) {
    return <div className="yoke yoke--standby"><DeckStandby model={model} /></div>;
  }

  const laneCount = model.scopedLanes.length;
  const laneNumber = Math.max(1, model.selectedIndex + 1);

  return (
    <div className="yoke">
      <div className="yoke__grip yoke__grip--left">
        <PrimaryKey model={model} size="xl" />
        <VoiceTrace model={model} />
        <StopKey model={model} block />

        <div className="yoke__stepper" role="group" aria-label="Lane navigation">
          <button
            type="button"
            onClick={() => model.stepLane(-1)}
            disabled={laneCount < 2}
            aria-label="Previous lane"
          >
            <ChevronIcon dir="left" />
          </button>
          <span>
            <strong>{String(laneNumber).padStart(2, "0")}</strong>
            <small>of {String(laneCount).padStart(2, "0")}</small>
          </span>
          <button
            type="button"
            onClick={() => model.stepLane(1)}
            disabled={laneCount < 2}
            aria-label="Next lane"
          >
            <ChevronIcon dir="right" />
          </button>
        </div>

        {/* The ladder is context for the stepper, not a second lane bank: it
            shows where each lane stands so stepping is never blind. */}
        <div className="yoke__ladder" role="group" aria-label="Lane ladder">
          {model.scopedLanes.map((item, index) => (
            <button
              type="button"
              key={item.key}
              data-active={item.key === lane.key || undefined}
              data-tone={laneTone(item)}
              onClick={() => model.selectLane(item)}
              aria-pressed={item.key === lane.key}
              aria-label={`${item.name} on ${item.hostName} — ${laneStateLabel(item.state)}`}
              title={`${item.name} · ${item.hostName} · ${laneStateLabel(item.state)}`}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <i aria-hidden="true" />
            </button>
          ))}
        </div>

        <div className="yoke__grip-keys">
          <VoiceOutKey model={model} />
          <SettingsKey model={model} />
        </div>

        <div className="yoke__grip-foot">
          <span className="deck-kicker">Lane traffic</span>
          <LaneActivity model={model} />
        </div>
      </div>

      <section className="yoke__stage">
        <header className="yoke__head">
          <div className="yoke__head-task">
            <TaskBinding model={model} size="lg" />
          </div>
          <div className="yoke__head-lane">
            <h2>{lane.name}</h2>
            <p>{lane.projectRoot ?? "Project unavailable"}</p>
          </div>
        </header>

        <PhaseLine model={model} />

        <div className="yoke__viewport">
          <div className="yoke__viewport-head">
            <ViewTabs model={model} />
            <span className="deck-kicker">{lane.hostName} / {lane.id}</span>
          </div>
          <div className="yoke__viewport-body">
            <LaneStream model={model} limit={10} />
          </div>
        </div>

        <div className="yoke__dock">
          <VoiceCaption model={model} />
          <Composer model={model} rows={2} />
        </div>
      </section>

      <aside className="yoke__grip yoke__grip--right" aria-label="Session status">
        <div className="yoke__status">
          <ConnectionChip model={model} />
          <dl>
            <div><dt>Lane state</dt><dd>{laneStateLabel(lane.state)}</dd></div>
            <div><dt>Harness</dt><dd>{lane.harness ?? "unknown"}</dd></div>
            <div><dt>Model</dt><dd>{lane.model ?? "default"}</dd></div>
            <div>
              <dt>Transport</dt>
              {/* The column is two words wide, so it carries the channel and
                  keeps the full host wording in the tooltip. */}
              <dd title={transportLabel(lane.transport)}>{transportShortLabel(lane.transport)}</dd>
            </div>
            <div><dt>Live lanes</dt><dd>{model.activeCount} of {laneCount}</dd></div>
          </dl>
        </div>

        <div className="yoke__grip-keys">
          <RefreshKey model={model} />
          <RebindKey model={model} />
        </div>

        <div className="yoke__attention">
          <span className="deck-kicker">Needs you · {String(model.attention.length).padStart(2, "0")}</span>
          <AttentionList model={model} />
        </div>

        <div className="yoke__scope">
          <span className="deck-kicker">Host scope</span>
          <HostScopeBar model={model} />
        </div>
      </aside>

      <AudioSettings model={model} />
    </div>
  );
}
