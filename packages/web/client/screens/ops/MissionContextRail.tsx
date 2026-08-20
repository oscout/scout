/**
 * Mission Control context rail — the composed reading of the pane under the
 * cursor, docked over the right edge of the wall.
 *
 * The wall itself stays raw (see MissionLogPane.tsx) and, crucially, stays put:
 * the rail overlays the grid instead of narrowing it, so opening it never
 * re-tiles the wall or moves the pane you were reading. It is not a dialog —
 * `hjkl` keeps moving the cursor underneath and the rail re-renders onto
 * whatever pane the cursor lands on, the way a mail reading pane follows the
 * selected row.
 *
 * Content is Agent Lanes' lane detail, narrowed to what fits a rail: the lane
 * headline, session vitals, runtime facts, touched files and recent commands —
 * the same builders (`agent-lane-detail.ts`, `agent-lane-preview.ts`) that
 * surface reads from, so a log described here and a lane described there cannot
 * drift apart.
 */
import { useMemo } from "react";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { bashDisplaySpans, splitCdPrefix, tildeShortenPath } from "../../lib/bash-format.ts";
import {
  contextBudgetBarWidth,
  deriveContextBudgetGauge,
} from "../../lib/context-budget.ts";
import { statusOnHover } from "../../lib/page-status.ts";
import { timeAgo } from "../../lib/time.ts";
import type { ObserveFile } from "../../lib/types.ts";
import {
  buildLaneSessionStats,
  buildLaneTouchedFiles,
  laneRecentCommands,
  type LaneCommand,
} from "./agent-lane-detail.ts";
import { buildAgentLanePreview } from "./agent-lane-preview.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import { missionRailNow } from "./mission-rail-model.ts";
import { missionLogTitle, type MissionLog } from "./mission-wall.ts";

const RAIL_FILE_LIMIT = 8;
const RAIL_COMMAND_LIMIT = 6;

/** The leading tonal mark for a touched-file row (same step as the lane sheet). */
const FILE_STATE_MARK: Record<string, string> = {
  created: "+",
  modified: "~",
  read: "○",
};

function shortPath(value: string | null | undefined, max = 42): string {
  if (!value) return "—";
  if (value.length <= max) return value;
  return `…${value.slice(-(max - 1))}`;
}

function splitLeaf(path: string): { dir: string; base: string } {
  const clean = path.replace(/\\/g, "/");
  const index = clean.lastIndexOf("/");
  if (index < 0) return { dir: "", base: clean };
  return { dir: clean.slice(0, index + 1), base: clean.slice(index + 1) };
}

export function MissionContextRail({
  log,
  lane,
  onClose,
  onExpand,
  onTail,
  onOpenLog,
  onOpenFile,
}: {
  log: MissionLog;
  lane: AgentLane;
  onClose: () => void;
  onExpand: () => void;
  onTail: () => void;
  onOpenLog: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { agent, observe } = lane;
  const stats = useMemo(() => buildLaneSessionStats(lane), [lane]);
  const preview = useMemo(
    () => buildAgentLanePreview(observe, agent, { isLive: log.live }),
    [observe, agent, log.live],
  );
  const now = useMemo(() => missionRailNow(preview, observe), [preview, observe]);
  const files = useMemo(() => buildLaneTouchedFiles(observe, RAIL_FILE_LIMIT), [observe]);
  const commands = useMemo(() => laneRecentCommands(observe, RAIL_COMMAND_LIMIT), [observe]);
  const gauge = useMemo(
    () => deriveContextBudgetGauge(stats.usage, { model: stats.model, adapterType: stats.harness }),
    [stats.usage, stats.model, stats.harness],
  );

  const title = missionLogTitle(log);
  const where = [log.project, agent.branch].filter(Boolean).join("/") || log.cwd || "—";
  const changed = files.filter((file) => file.state !== "read").length;

  const facts: Array<[string, string, string | null]> = [
    ["MODEL", [stats.harness, stats.model].filter(Boolean).join("/") || "—", null],
    ["BRANCH", stats.branch ?? "—", null],
    ["CWD", shortPath(stats.cwd), stats.cwd],
    ["SESSION", shortPath(stats.sessionId, 30), stats.sessionId],
    ["LOG", shortPath(log.logPath, 30), log.logPath],
  ];

  return (
    <aside className="s-wall-rail" aria-label={`${title} context`}>
      <div className="s-wall-rail-head">
        <span
          className={`s-wall-rail-dot${log.live ? " s-wall-rail-dot--live" : ""}`}
          aria-hidden="true"
        />
        <HarnessMark harness={log.source} size={12} title={null} />
        <div className="s-wall-rail-identity">
          <div className="s-wall-rail-title" title={agent.name}>{title}</div>
          <div className="s-wall-rail-sub" title={log.cwd ?? where}>
            {where} · {log.lastActiveAt ? timeAgo(log.lastActiveAt) : "idle"}
          </div>
        </div>
        <button
          type="button"
          className="s-wall-rail-close"
          onClick={onClose}
          aria-label="Close context (Esc)"
          title="Close context (Esc)"
        >
          ✕
        </button>
      </div>

      <div className="s-wall-rail-body">
        <section className="s-wall-rail-sec">
          <div className="s-wall-rail-sechead">
            <span className="s-wall-rail-seclabel">{log.live ? "executing now" : "last action"}</span>
            <span className="s-wall-rail-secrule" aria-hidden="true" />
          </div>
          {now ? (
            <div className="s-wall-rail-now">
              <div className="s-wall-rail-headline" title={now.full}>{now.headline}</div>
              {now.detail && (
                <div className="s-wall-rail-detail" title={now.detail}>{now.detail}</div>
              )}
            </div>
          ) : (
            <div className="s-wall-rail-empty">
              No interpreted trace yet — the pane is streaming raw output.
            </div>
          )}

          <dl className="s-wall-rail-stats">
            <RailStat label="events" value={stats.events} />
            <RailStat label="tools" value={stats.tools} />
            <RailStat label="edits" value={stats.edits} />
            <RailStat label="reads" value={stats.reads} />
            <RailStat label="files" value={stats.files} />
          </dl>

          {gauge && (
            <div className={`s-wall-rail-gauge${gauge.overLimit ? " s-wall-rail-gauge--over" : ""}`}>
              <div className="s-wall-rail-gauge-line">
                <span className="s-wall-rail-gauge-label">context</span>
                <span className="s-wall-rail-gauge-value">
                  {gauge.usedLabel}
                  <span className="s-wall-rail-gauge-of"> / {gauge.budgetLabel}</span>
                </span>
                <span className="s-wall-rail-gauge-pct">
                  {gauge.pct}%{gauge.overLimit ? " over" : ""}
                </span>
              </div>
              <div
                className="s-wall-rail-gauge-bar"
                role="progressbar"
                aria-label="Context budget"
                aria-valuenow={gauge.pct}
                aria-valuemin={0}
                aria-valuemax={Math.max(100, gauge.pct)}
              >
                <span
                  className="s-wall-rail-gauge-fill"
                  style={{ width: `${contextBudgetBarWidth(gauge)}%` }}
                />
              </div>
            </div>
          )}
        </section>

        <section className="s-wall-rail-sec">
          <div className="s-wall-rail-sechead">
            <span className="s-wall-rail-seclabel">runtime</span>
            <span className="s-wall-rail-secrule" aria-hidden="true" />
          </div>
          <dl className="s-wall-rail-facts">
            {facts.map(([label, value, full]) => (
              <div key={label} className="s-wall-rail-fact">
                <dt className="s-wall-rail-fact-label">{label}</dt>
                <dd className="s-wall-rail-fact-value" title={full ?? value}>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="s-wall-rail-sec">
          <div className="s-wall-rail-sechead">
            <span className="s-wall-rail-seclabel">files</span>
            {files.length > 0 && (
              <span className="s-wall-rail-seccount">
                {changed} changed · {files.length - changed} read
              </span>
            )}
            <span className="s-wall-rail-secrule" aria-hidden="true" />
          </div>
          {files.length === 0 ? (
            <div className="s-wall-rail-empty">No files touched in this window.</div>
          ) : (
            <div className="s-wall-rail-files">
              {files.map((file) => (
                <RailFileRow key={`${file.path}:${file.lastT}`} file={file} onOpen={onOpenFile} />
              ))}
            </div>
          )}
        </section>

        <section className="s-wall-rail-sec">
          <div className="s-wall-rail-sechead">
            <span className="s-wall-rail-seclabel">commands</span>
            {commands.length > 0 && <span className="s-wall-rail-seccount">{commands.length}</span>}
            <span className="s-wall-rail-secrule" aria-hidden="true" />
          </div>
          {commands.length === 0 ? (
            <div className="s-wall-rail-empty">No shell commands in this window.</div>
          ) : (
            <div className="s-wall-rail-cmds">
              {commands.map((entry) => <RailCommandRow key={entry.id} entry={entry} />)}
            </div>
          )}
        </section>
      </div>

      <div className="s-wall-rail-foot">
        <button
          type="button"
          className="s-wall-rail-act"
          onClick={onExpand}
          {...statusOnHover({ label: `Expand ${title}` })}
        >
          Expand
        </button>
        <button
          type="button"
          className="s-wall-rail-act"
          onClick={onTail}
          {...statusOnHover({
            label: `Tail · ${title}`,
            route: `/ops/tail?q=${encodeURIComponent(log.sessionId)}`,
          })}
        >
          Tail ↗
        </button>
        <button
          type="button"
          className="s-wall-rail-act"
          onClick={onOpenLog}
          {...statusOnHover({
            label: `Session · ${log.sessionId}`,
            route: `/sessions/${log.sessionId}`,
          })}
        >
          Session ↗
        </button>
        <span className="s-wall-rail-keys">
          <kbd>hjkl</kbd> move · <kbd>esc</kbd> close
        </span>
      </div>
    </aside>
  );
}

function RailStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="s-wall-rail-stat">
      <dt className="s-wall-rail-stat-label">{label}</dt>
      <dd className="s-wall-rail-stat-value">{value > 0 ? value.toLocaleString() : "—"}</dd>
    </div>
  );
}

function RailFileRow({
  file,
  onOpen,
}: {
  file: ObserveFile;
  onOpen: (path: string) => void;
}) {
  const { dir, base } = splitLeaf(file.path);
  return (
    <button
      type="button"
      className="s-wall-rail-frow"
      title={file.path}
      onClick={() => onOpen(file.path)}
    >
      <span className={`s-wall-rail-fstate s-wall-rail-fstate--${file.state}`} aria-hidden="true">
        {FILE_STATE_MARK[file.state] ?? "○"}
      </span>
      <span className="s-wall-rail-fpath">
        {dir && <span className="s-wall-rail-fdir">{dir}</span>}
        <span className="s-wall-rail-fbase">{base}</span>
      </span>
    </button>
  );
}

function RailCommandRow({ entry }: { entry: LaneCommand }) {
  const { dir, rest } = splitCdPrefix(tildeShortenPath(entry.command));
  const spans = bashDisplaySpans(rest || entry.command);
  return (
    <div className="s-wall-rail-crow" title={entry.command}>
      <span className="s-wall-rail-cmark" aria-hidden="true">❯</span>
      <span className="s-wall-rail-ctext">
        {dir && <span className="s-wall-rail-bash-dir">{dir}/</span>}
        {spans.map((span, index) => (
          <span
            key={index}
            className={`s-wall-rail-bash-${span.tier}${span.flag ? " s-wall-rail-bash-flag" : ""}`}
          >
            {index > 0 ? " " : ""}{span.text}
          </span>
        ))}
      </span>
      {entry.outcome && <span className="s-wall-rail-cresult">{entry.outcome}</span>}
    </div>
  );
}
