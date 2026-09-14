import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CrewSprite } from "../../../components/CrewSprite.tsx";
import { SproutActionSprite } from "../../../components/SproutActionSprite.tsx";
import { matchCastSlug } from "../../../lib/crew-registry.ts";
import type { AgentLane } from "../agent-lanes-model.ts";
import { adventurePlayback } from "../adventure-playback.ts";
import type { AdventureEvidenceModel } from "../adventure-evidence.ts";
import type { AdventureStop } from "../agent-adventures-model.ts";
import panoramaUrl from "../assets/adventure-habitats-v1.png?url";
import {
  ACTIVITY,
  bubbleFor,
  bubbleHeadroom,
  bubbleLines,
  cameraFor,
  DISTRICT_OF,
  facesLeft,
  layoutGround,
  PANORAMA_RATIO,
  ridgeWeight,
  screenX as screenXOf,
  showsCaption,
  spriteAction,
  SPRITE_SIZE,
  travelMs as travelMsFor,
  type ReplayKind,
  type ReplayViewport,
  type SpritePhase,
} from "./replay-outpost-model.ts";
import "./replay-outpost.css";

/**
 * Replay as one continuous section through the outpost.
 *
 * Sky and surface above the cut, the ridge sitting on the ground line, the
 * record of the run carved into the strata below it. Three surfaces with three
 * jobs, where the shipped view had the stage and the timeline fighting over
 * one 3300px strip with the painting tiled and mirrored behind it.
 *
 * The stage shows only where the agent is NOW. The ridge carries the whole
 * journey and replaces the scrubber, the checkpoint markers, the
 * checkpoint-mode select, the next-review button and the counter. The
 * subsurface carries the log and the satchel.
 *
 * Geometry and grammar live in `replay-outpost-model.ts` so they stay testable.
 */

/** Category, never status — outcome colour is reserved for real outcomes. */
const KIND_HUE: Record<ReplayKind, string> = {
  start: "var(--s-dim)",
  think: "var(--s-muted)",
  read: "var(--cat-sky)",
  edit: "var(--cat-gold)",
  tool: "var(--cat-purple)",
  message: "var(--info)",
  wait: "var(--color-status-warn-fg)",
  end: "var(--color-status-ok-fg)",
  stopped: "var(--color-status-error-fg)",
};

export type ReplayInspectTarget =
  | { type: "file"; path: string; changed: boolean; clue: string; observations: number }
  | { type: "run"; id: string; command: string; outcome: "passed" | "failed" | "unavailable"; clue: string };

export type ReplayOutpostProps = {
  stops: readonly AdventureStop[];
  index: number;
  onSeek: (index: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  actor: AgentLane | null;
  evidence: AdventureEvidenceModel;
  /** Rendered beside the agent when the current stop hands work to someone. */
  recipient?: AgentLane | null;
  /** Freeze every animation — page hidden, tile offscreen, reduced motion. */
  paused?: boolean;
  /** Journey picker and anything else the host owns, shown in the header. */
  header?: React.ReactNode;
  /**
   * Opt out of the built-in drawer to open the full field journal instead.
   * Without it, collected items open the drawer this component owns.
   */
  onInspect?: (target: ReplayInspectTarget) => void;
};

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function ReplayOutpost({
  stops, index, onSeek, playing, onPlayingChange, speed, onSpeedChange,
  actor, evidence, recipient, paused = false, header, onInspect,
}: ReplayOutpostProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const ridgeRef = useRef<HTMLDivElement>(null);
  const currentRowRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ReplayViewport>({ stageWidth: 1080, panoramaWidth: 1410 });
  const [stageHeight, setStageHeight] = useState(420);
  const [phase, setPhase] = useState<SpritePhase>("work");
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = useState<ReplayInspectTarget | null>(null);

  /* The camera maths is in stage pixels, so it has to follow the real box
     rather than a design-time constant. */
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      const panoramaHeight = Math.max(height * 1.12, height + 50);
      setView({ stageWidth: width, panoramaWidth: Math.max(width, panoramaHeight * PANORAMA_RATIO) });
      setStageHeight(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const kinds = useMemo(() => stops.map((stop) => stop.kind as ReplayKind), [stops]);
  const beats = useMemo(() => stops.map((stop) => adventurePlayback(stop)), [stops]);
  const ground = useMemo(() => layoutGround(kinds, view), [kinds, view]);

  const cursor = Math.max(0, Math.min(stops.length - 1, index));
  const stop = stops[cursor];
  const beat = beats[cursor];
  const kind = kinds[cursor];

  const screenX = stop ? screenXOf(ground[cursor], DISTRICT_OF[kind], view) : view.stageWidth / 2;
  const camera = stop ? cameraFor(DISTRICT_OF[kind], view) : 0;

  /* Facing and travel time come from where he ACTUALLY is. Deriving them from
     the preceding stop describes a move he never made whenever the ridge is
     scrubbed, and he sprints one way while facing the other. */
  const cameFrom = useRef(screenX);
  const previousX = cameFrom.current;
  const facingLeft = facesLeft(previousX, screenX);
  const travelMs = travelMsFor(previousX, screenX, speed);
  useEffect(() => { cameFrom.current = screenX; }, [screenX]);
  const moveMs = playing ? travelMs : 260;

  /* A stop is two beats: travel to it, then work at it. */
  useEffect(() => {
    if (!playing || !beat) { setPhase("work"); return; }
    setPhase("travel");
    const landMs = 260 / Math.max(0.25, speed);
    const toLand = window.setTimeout(() => setPhase(beat.checkpoint ? "land" : "work"), travelMs);
    const toWork = window.setTimeout(() => setPhase("work"), travelMs + landMs);
    return () => { window.clearTimeout(toLand); window.clearTimeout(toWork); };
    // travelMs is derived from cursor and speed, both listed.
  }, [cursor, playing, speed, beat?.checkpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Advance on the stop's own measured duration. */
  useEffect(() => {
    if (!playing || !beat) return;
    if (cursor + 1 >= stops.length) { onPlayingChange(false); return; }
    const timer = window.setTimeout(() => onSeek(cursor + 1), Math.min(beat.durationMs, 2600) / speed);
    return () => window.clearTimeout(timer);
  }, [playing, cursor, speed, beat, stops.length, onSeek, onPlayingChange]);

  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor]);

  const elapsed = useMemo(
    () => beats.slice(0, cursor + 1).reduce((sum, item) => sum + item.durationMs, 0),
    [beats, cursor],
  );
  const total = useMemo(() => beats.reduce((sum, item) => sum + item.durationMs, 0), [beats]);

  const seek = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const box = ridgeRef.current?.getBoundingClientRect();
    if (!box || stops.length < 2) return;
    const at = (event.clientX - box.left) / box.width;
    onSeek(Math.max(0, Math.min(stops.length - 1, Math.round(at * (stops.length - 1)))));
  }, [onSeek, stops.length]);

  const inspect = useCallback((target: ReplayInspectTarget) => {
    if (onInspect) onInspect(target);
    else setOpen(target);
  }, [onInspect]);

  /* One cast, one rule: the name matches a member or it does not. Handing an
     unmatched agent a hashed member's face is a lie about who you are looking
     at, which is exactly what `assignCastSlug` warns against. */
  const slug = actor ? matchCastSlug(actor.agent.name) : undefined;
  const recipientSlug = recipient ? matchCastSlug(recipient.agent.name) : undefined;
  const thinking = kind === "think" && phase === "work";

  /* Two of the nine kinds are the agent's own words rather than facts about a
     step, and those go over his head. Only once he has stopped running — a
     bubble trailing a sprinting character reads as a billboard — and the
     caption never stands in for it in the meantime, because swapping one for
     the other mid-beat is a flicker, not a transition. */
  const bubble = phase === "work" ? bubbleFor(kind) : null;
  /* Clamped to what this sky can hold, not to a guessed constant. The log below
     the ground always carries the full text. */
  const lines = bubbleLines(bubbleHeadroom(stageHeight, stageHeight * 0.38));
  const action = spriteAction(phase, Boolean(beat?.checkpoint));
  const frozen = paused || !playing;

  if (!stop || !beat) return null;

  return (
    <div className="replay-outpost">
      <div className="replay-outpost__head">
        {slug ? <CrewSprite slug={slug} size={26} paused={paused} /> : null}
        <div className="replay-outpost__who">{actor?.agent.name ?? "Unknown agent"}</div>
        <div className="replay-outpost__spacer" />
        {header}
      </div>

      {/* ---- above the cut ---- */}
      <div className="replay-outpost__stage" ref={stageRef}>
        <img
          className="replay-outpost__panorama"
          src={panoramaUrl}
          alt=""
          draggable={false}
          style={{
            width: view.panoramaWidth,
            transform: `translateX(${camera}px)`,
            transitionDuration: `${moveMs}ms`,
          }}
        />
        <div className="replay-outpost__veil" />

        <div className="replay-outpost__hud">
          <span className="replay-outpost__hud-dot" data-failed={beat.checkpoint && kind === "stopped" ? "" : undefined} />
          <span className="replay-outpost__hud-who">{actor?.agent.name ?? ""}</span>
          <span className="replay-outpost__hud-step">{cursor + 1} / {stops.length}</span>
        </div>

        <div
          className="replay-outpost__actor"
          style={{ transform: `translateX(${screenX - SPRITE_SIZE / 2}px)`, transitionDuration: `${moveMs}ms` }}
        >
          <div
            className={`replay-outpost__art${action === "jump" ? " is-hopping" : ""}`}
            style={{ transform: facingLeft ? "scaleX(-1)" : undefined, animationDuration: `${travelMs}ms` }}
          >
            {thinking && slug ? (
              /* No thinking row in the action atlas yet, so the state comes from
                 the authored look-up eye patch on the standing pose. Bust and
                 atlas are framed alike to within 1%, so the swap does not jump. */
              <span className="replay-outpost__standing">
                <CrewSprite slug={slug} size={SPRITE_SIZE} paused={paused} expression="look-up" />
              </span>
            ) : slug === "sprout" ? (
              <SproutActionSprite action={action} size={SPRITE_SIZE} paused={frozen} playbackRate={speed} />
            ) : slug ? (
              <span className="replay-outpost__standing">
                <CrewSprite slug={slug} size={SPRITE_SIZE} paused={paused} />
              </span>
            ) : null}
          </div>
          <div className="replay-outpost__shadow" />

          {/* A beat speaks or it reports — never both, because that says the
              same thing twice. The shape of the bubble is the label. */}
          {bubble === "thought" ? (
            <div
              className="replay-outpost__bubble is-thought"
              style={{ ["--replay-bubble-lines" as string]: lines }}
            >
              <p className="replay-outpost__bubble-text">{stop.event.text.trim()}</p>
              <span className="replay-outpost__puff is-big" />
              <span className="replay-outpost__puff is-small" />
            </div>
          ) : bubble === "speech" ? (
            <div
              className="replay-outpost__bubble is-speech"
              style={{ ["--replay-bubble-lines" as string]: lines }}
            >
              {/* Only when the recipient is not already standing there with
                  their name under them. */}
              {stop.event.to && !recipientSlug ? (
                <span className="replay-outpost__bubble-to">to {stop.event.to}</span>
              ) : null}
              <p className="replay-outpost__bubble-text">
                {stop.event.text.trim() || beat.label || stop.label}
              </p>
              <span className="replay-outpost__tail" />
            </div>
          ) : showsCaption(kind) ? (
            /* Paths, commands and exit codes are data about the step. They stay
               at his feet, where a long path can run wide without crowding him. */
            <div className="replay-outpost__doing">
              <div className="replay-outpost__activity">{ACTIVITY[kind]}</div>
              <div className="replay-outpost__target">
                {beat.label || stop.artifact || stop.label}
              </div>
            </div>
          ) : null}
        </div>

        {stop.event.to && recipientSlug ? (
          <div
            className="replay-outpost__handoff"
            style={{ left: screenX + 170, transitionDuration: `${moveMs}ms` }}
          >
            <span className="replay-outpost__standing">
              <CrewSprite slug={recipientSlug} size={78} paused={paused} />
            </span>
            <div className="replay-outpost__shadow is-small" />
            <div className="replay-outpost__handoff-label">to {stop.event.to}</div>
          </div>
        ) : null}
      </div>

      {/* ---- the ground line ---- */}
      <div className="replay-outpost__ridge">
        <div className="replay-outpost__transport">
          <button
            type="button"
            className="replay-outpost__play"
            onClick={() => onPlayingChange(!playing)}
            aria-label={playing ? "Pause replay" : "Play replay"}
          >
            {playing
              ? <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><rect width="3" height="10" fill="currentColor" /><rect x="6" width="3" height="10" fill="currentColor" /></svg>
              : <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M0 0l9 5-9 5z" fill="currentColor" /></svg>}
          </button>
          <select
            className="replay-outpost__speed"
            value={speed}
            onChange={(event) => onSpeedChange(Number(event.target.value))}
            aria-label="Replay speed"
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </div>

        <div className="replay-outpost__bars" ref={ridgeRef} onClick={seek} onMouseLeave={() => setHover(null)}>
          {stops.map((item, i) => (
            <div
              key={item.id}
              className={`replay-outpost__bar${i <= cursor ? " is-seen" : ""}${i === cursor ? " is-now" : ""}`}
              style={{ height: `${ridgeWeight(beats[i]) * 100}%`, color: KIND_HUE[kinds[i]] }}
              onMouseEnter={() => setHover(i)}
            >
              {beats[i].checkpoint ? <span className="replay-outpost__flag" /> : null}
            </div>
          ))}
          {hover !== null && stops[hover] ? (
            <div className="replay-outpost__tip" style={{ left: `${((hover + 0.5) / stops.length) * 100}%` }}>
              <div className="replay-outpost__tip-kind" style={{ color: KIND_HUE[kinds[hover]] }}>
                {ACTIVITY[kinds[hover]]} · {clock(beats[hover].durationMs)}
              </div>
              <div className="replay-outpost__tip-title">{beats[hover].label || stops[hover].artifact}</div>
            </div>
          ) : null}
        </div>

        <div className="replay-outpost__elapsed">
          {clock(elapsed)} <span>/ {clock(total)}</span>
        </div>
      </div>

      {/* ---- below the cut ---- */}
      <div className="replay-outpost__subsurface">
        <div className="replay-outpost__log">
          {stops.map((item, i) => (
            <div
              key={item.id}
              ref={i === cursor ? currentRowRef : undefined}
              className={`replay-outpost__row${i === cursor ? " is-now" : ""}${i > cursor ? " is-ahead" : ""}`}
              style={{ color: KIND_HUE[kinds[i]] }}
            >
              <span className="replay-outpost__at">
                {clock(beats.slice(0, i + 1).reduce((sum, b) => sum + b.durationMs, 0))}
              </span>
              <span className="replay-outpost__pip" />
              <span className="replay-outpost__text">
                <span className="replay-outpost__title">{beats[i].label || item.artifact || item.label}</span>
                <span className="replay-outpost__activity-small">{ACTIVITY[kinds[i]]}</span>
              </span>
              <span className="replay-outpost__ms">{Math.round(beats[i].durationMs)}ms</span>
            </div>
          ))}
        </div>

        <div className="replay-outpost__satchel">
          <div className="replay-outpost__satchel-head">
            <span>Collected</span>
            <span>{evidence.changed.length + evidence.runs.length + evidence.read.length}</span>
          </div>
          {!evidence.changed.length && !evidence.runs.length && !evidence.read.length ? (
            <p className="replay-outpost__satchel-empty">
              Nothing gathered yet — the satchel fills as the run proceeds.
            </p>
          ) : null}

          <Shelf name="Changed" hue="var(--cat-gold)" count={evidence.changed.length}>
            {evidence.changed.map((file) => (
              <ShelfRow
                key={file.path}
                label={file.path}
                onOpen={() => inspect({ type: "file", path: file.path, changed: true, clue: file.clue, observations: file.observations })}
              />
            ))}
          </Shelf>
          <Shelf name="Proved" hue="var(--cat-purple)" count={evidence.runs.length}>
            {evidence.runs.map((run) => (
              <ShelfRow
                key={run.id}
                label={run.command}
                note={run.outcome === "passed" ? "passed" : run.outcome === "failed" ? "failed" : undefined}
                failed={run.outcome === "failed"}
                onOpen={() => inspect({ type: "run", id: run.id, command: run.command, outcome: run.outcome, clue: run.clue })}
              />
            ))}
          </Shelf>
          <Shelf name="Explored" hue="var(--cat-sky)" count={evidence.read.length}>
            {evidence.read.map((file) => (
              <ShelfRow
                key={file.path}
                label={file.path}
                onOpen={() => inspect({ type: "file", path: file.path, changed: false, clue: file.clue, observations: file.observations })}
              />
            ))}
          </Shelf>
        </div>
      </div>

      {open ? <InspectDrawer target={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function Shelf({ name, hue, count, children }: { name: string; hue: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="replay-outpost__shelf">
      <div className="replay-outpost__shelf-name" style={{ color: hue }}>
        {name} <span>{count}</span>
      </div>
      <ul className="replay-outpost__shelf-list">{children}</ul>
    </div>
  );
}

function ShelfRow({ label, note, failed, onOpen }: { label: string; note?: string; failed?: boolean; onOpen: () => void }) {
  return (
    <li className="replay-outpost__shelf-item">
      <button type="button" className="replay-outpost__shelf-button" onClick={onOpen} data-failed={failed ? "" : undefined}>
        {note ? <b>{note}</b> : null}
        <span>{label}</span>
      </button>
    </li>
  );
}

/**
 * A drawer over the section rather than a modal that blanks it — the run stays
 * visible behind, so opening a file never costs you your place in the journey.
 */
function InspectDrawer({ target, onClose }: { target: ReplayInspectTarget; onClose: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const failed = target.type === "run" && target.outcome === "failed";
  return (
    <>
      <button type="button" className="replay-outpost__scrim" onClick={onClose} aria-label="Close" />
      <aside className="replay-outpost__reader" role="dialog" aria-label={target.type === "file" ? target.path : target.command}>
        <div className="replay-outpost__reader-head">
          <div className="replay-outpost__reader-kind" data-failed={failed ? "" : undefined}>
            {target.type === "file" ? (target.changed ? "Changed" : "Explored") : "Proved"}
          </div>
          <div className="replay-outpost__reader-title">{target.type === "file" ? target.path : target.command}</div>
          <div className="replay-outpost__reader-meta">
            {target.type === "file"
              ? `${target.observations} observation${target.observations === 1 ? "" : "s"}`
              : target.outcome}
          </div>
          <button type="button" className="replay-outpost__reader-close" onClick={onClose} aria-label="Close">
            <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
              <path d="M1 1l7 7M8 1l-7 7" stroke="currentColor" strokeWidth="1.4" fill="none" />
            </svg>
          </button>
        </div>
        <div className="replay-outpost__reader-body">{target.clue || "Nothing captured for this item."}</div>
      </aside>
    </>
  );
}
