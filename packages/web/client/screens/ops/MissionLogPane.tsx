/**
 * One pane of the Mission Control wall: a live tail of a single log.
 *
 * Deliberately under-designed. Agent Lanes is the composed, interpreted view of
 * an agent; this is the raw one — the same row dialect as /ops/tail, with the
 * columns that are constant inside a pane (source, project, session) lifted
 * into a single header line so the body is nothing but log output.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { statusOnHover } from "../../lib/page-status.ts";
import {
  collapseTailDisplayRows,
  observeToolFieldsFromTailEvent,
  TAIL_KIND_GLYPH,
  TAIL_KIND_LABEL,
} from "../../lib/tail-display.ts";
import { formatClockTimestamp } from "../../lib/time.ts";
import { stateChipColor } from "./mission-control-model.ts";
import {
  missionLogFileLabel,
  missionLogTitle,
  type MissionLog,
} from "./mission-wall.ts";

/** Within this many pixels of the bottom still counts as "following". */
const FOLLOW_SLACK_PX = 24;

export function MissionLogPane({
  log,
  selected,
  revealed,
  cursor = false,
  onOpen,
  onToggleSelected,
  onOpenLog,
  paneRef,
}: {
  log: MissionLog;
  selected: boolean;
  revealed: boolean;
  /** The pane the keyboard cursor is parked on — see mission-cursor.ts. */
  cursor?: boolean;
  onOpen: () => void;
  onToggleSelected: () => void;
  onOpenLog: () => void;
  paneRef?: (node: HTMLDivElement | null) => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  // A harness that re-states the same line (polling loops, retried tools) would
  // otherwise fill the pane with its own echo. Same collapse rule as /ops/tail.
  //
  // A tool result's outcome is read here, inside the same memo, rather than per
  // render: 22 panes × hundreds of rows × a regex-heavy parse is not a per-frame
  // cost the wall can carry.
  const rows = useMemo(
    () => collapseTailDisplayRows(log.lines.map((event) => ({ event, meta: undefined })))
      .map((row) => ({
        ...row,
        outcome: row.event.kind === "tool-result"
          ? observeToolFieldsFromTailEvent(row.event).result?.outcome ?? null
          : null,
      })),
    [log.lines],
  );

  const onScroll = useCallback(() => {
    const node = bodyRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    followRef.current = distance <= FOLLOW_SLACK_PX;
  }, []);

  // Stick to the newest line unless the operator has scrolled back to read.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [rows.length, log.lastActiveAt]);

  const state = normalizeAgentState(log.agent?.state ?? null);
  const title = missionLogTitle(log);
  const file = missionLogFileLabel(log);
  const where = [log.project, log.agent?.branch].filter(Boolean).join("/") || log.cwd || "—";

  const hover = statusOnHover({
    label: `Focus ${title}`,
    route: `/ops/control · ${log.sessionId}`,
  });

  const onPaneClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      onToggleSelected();
      return;
    }
    onOpen();
  };

  return (
    <div
      ref={paneRef}
      className={[
        "s-wall-pane",
        log.live ? "s-wall-pane--live" : null,
        selected ? "s-wall-pane--selected" : null,
        revealed ? "s-wall-pane--revealed" : null,
        cursor ? "s-wall-pane--cursor" : null,
      ].filter(Boolean).join(" ")}
      data-cursor={cursor ? true : undefined}
      tabIndex={cursor ? 0 : -1}
      onClick={onPaneClick}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
    >
      <div className="s-wall-pane-head">
        <span
          className="s-wall-pane-dot"
          style={{ background: log.agent ? stateChipColor(state) : "var(--dim)" }}
          aria-hidden
        />
        <HarnessMark harness={log.source} size={11} title={null} />
        <button
          type="button"
          className="s-wall-pane-title"
          title={log.agent?.name ?? log.sessionId}
          aria-label={`Focus ${title}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {title}
        </button>
        <span className="s-wall-pane-where" title={log.cwd ?? where}>
          {where}
        </span>
        <span className="s-wall-pane-spacer" />
        {log.live && <span className="s-wall-pane-live">live</span>}
        <button
          type="button"
          className="s-wall-pane-file"
          title={log.logPath ?? `session ${log.sessionId}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenLog();
          }}
        >
          {file}
        </button>
      </div>

      <div className="s-wall-pane-body" ref={bodyRef} onScroll={onScroll}>
        {rows.length === 0 ? (
          <div className="s-wall-pane-idle">
            no output since page load
          </div>
        ) : (
          rows.map(({ event: line, repeatCount, outcome }) => (
            <div
              key={line.id}
              className={[
                "s-wall-line",
                `s-wall-line--${line.kind}`,
                outcome === "success" ? "s-wall-line--result-ok" : null,
                outcome === "error" ? "s-wall-line--result-error" : null,
              ].filter(Boolean).join(" ")}
            >
              <span className="s-wall-line-time">
                {formatClockTimestamp(line.ts, { milliseconds: false }) || "—"}
              </span>
              {/* Glyph only, no kind label: pane width is scarce and every
                  column stolen from the text is log content lost. */}
              <span className="s-wall-line-glyph" title={TAIL_KIND_LABEL[line.kind]}>
                {TAIL_KIND_GLYPH[line.kind]}
              </span>
              <span className="s-wall-line-text">
                {line.summary}
                {repeatCount > 1 && (
                  <span className="s-wall-line-repeat" title={`${repeatCount} identical events`}>
                    {" "}×{repeatCount}
                  </span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
