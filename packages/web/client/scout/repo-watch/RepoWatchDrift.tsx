/**
 * Repo Watch — "Branch Drift", a horizontal commit-scale visualization.
 *
 * A second view alongside the Fleet Table. Where the table reads as a dense
 * console grid, Drift reads as a ruler: every worktree of every repo plotted on
 * one fixed COMMIT SCALE (behind ← origin → ahead, ±8 commits, origin centered)
 * so you can see at a glance which branches have drifted and which need a
 * rebase. No clean-tray fold — the point is seeing every branch's distance.
 *
 * Same snapshot, same derivations as the table (state dot, churn split-bar,
 * agent dedupe — all from ./ui.ts). Calmer still: neutral agent avatars, muted
 * flag pills, no glow / pulse anywhere. Styles live in ./console.css under the
 * `.bd-*` prefix; the palette comes from the `.rw-scope` tone ancestor.
 */

import "./console.css";
import type {
  RepoWatchSnapshot,
  RepoWatchWorktree,
  RepoWatchProject,
  RepoWatchAgentRef,
} from "./types.ts";
import {
  shortPath,
  agentLive,
  agentHandle,
  uniqueAgents,
  reviewChurnOf,
  wtState,
  fmt,
} from "./ui.ts";
import { BranchLabel } from "./parts.tsx";

/* Fixed commit scale: origin centered, ±8 commits to each edge. */
const SCALE = 8;

/* Worst-first within a repo: error → diverged → behind/ahead → in-sync. */
function rowRank(wt: RepoWatchWorktree): number {
  if (wt.error != null) return 0;
  const { ahead, behind } = wt.branch;
  if (ahead > 0 && behind > 0) return 1;
  if (behind > 0 || ahead > 0) return 2;
  return 3;
}

/* Two-letter initials from an agent's display name / handle. "Hudson Logo"→HL,
 * "Talkie"→TA. Falls back to the handle's first two alpha chars. */
function initials(agent: RepoWatchAgentRef): string {
  const raw = (agent.name ?? "").trim();
  if (raw) {
    const words = raw.split(/[\s_\-/]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  }
  const h = agentHandle(agent).replace(/^@/, "");
  const alpha = h.replace(/[^a-z0-9]/gi, "");
  return (alpha.slice(0, 2) || "··").toUpperCase();
}

export default function RepoWatchDrift({
  snapshot,
  selectedId,
  onSelect,
}: {
  snapshot: RepoWatchSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="bd">
      <div className="bd-head">
        BRANCH DRIFT — distance from each worktree&apos;s base · behind ← origin →
        ahead · flags call out what needs a rebase
      </div>

      {/* Fixed commit-scale axis, aligned to the track column. */}
      <div className="bd-axis">
        <div />
        <div className="bd-axis-track">
          <span className="bd-axis-lbl" style={{ left: "0%" }}>
            −8
          </span>
          <span className="bd-axis-lbl" style={{ left: "25%" }}>
            −4
          </span>
          <span className="bd-axis-lbl bd-origin-lbl" style={{ left: "50%" }}>
            origin
          </span>
          <span className="bd-axis-lbl" style={{ left: "75%" }}>
            +4
          </span>
          <span className="bd-axis-lbl" style={{ left: "100%" }}>
            +8
          </span>
          <span className="bd-axis-cap">COMMITS ←</span>
        </div>
        <div />
        <div />
        <div />
      </div>

      {snapshot.projects.map((project) => (
        <RepoSection
          key={project.id}
          project={project}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </section>
  );
}

function RepoSection({
  project,
  selectedId,
  onSelect,
}: {
  project: RepoWatchProject;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const worktrees = [...project.worktrees].sort(
    (a, b) => rowRank(a) - rowRank(b),
  );
  return (
    <div className="bd-grp">
      <div className="bd-grp-h">
        <span className="bd-grp-nm">{project.name}</span>
        <span className="bd-grp-path">{shortPath(project.root, 3)}</span>
      </div>
      {worktrees.map((wt) => (
        <DriftRow
          key={wt.id}
          wt={wt}
          selected={selectedId === wt.id}
          onSelect={() => onSelect(wt.id)}
        />
      ))}
    </div>
  );
}

function DriftRow({
  wt,
  selected,
  onSelect,
}: {
  wt: RepoWatchWorktree;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = wtState(wt);
  const { ahead, behind } = wt.branch;
  const hasError = wt.error != null;
  const agents = uniqueAgents(wt);

  return (
    <div
      className={["bd-row", selected ? "sel" : ""].join(" ")}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* identity */}
      <div className="bd-id">
        <span className={"dot " + state} />
        <span className="bd-br">
          <BranchLabel branch={wt.branch} fallback={wt.name} />
        </span>
      </div>

      {/* drift track */}
      <DriftTrack ahead={ahead} behind={behind} hasError={hasError} />

      {/* churn */}
      <Churn wt={wt} hasError={hasError} />

      {/* agents */}
      <Avatars agents={agents} />

      {/* flag */}
      <Flag ahead={ahead} behind={behind} hasError={hasError} />
    </div>
  );
}

/* The hero. Origin sits at the track's horizontal center (50%). On a fixed ±8
 * scale, `behind` extends left from origin and `ahead` extends right; the bar
 * length is min(n,8)/8 of that half. Diverged → one continuous bar spanning
 * both halves. In sync → a hollow ring at origin, no bar. The label always
 * shows the ACTUAL count even when the bar is clamped at 8. */
function DriftTrack({
  ahead,
  behind,
  hasError,
}: {
  ahead: number;
  behind: number;
  hasError: boolean;
}) {
  const insync = ahead === 0 && behind === 0;

  return (
    <div className="bd-track">
      {/* ticks */}
      <span className="bd-tick" style={{ left: "0%" }} />
      <span className="bd-tick" style={{ left: "25%" }} />
      <span className="bd-tick bd-tick-origin" style={{ left: "50%" }} />
      <span className="bd-tick" style={{ left: "75%" }} />
      <span className="bd-tick" style={{ left: "100%" }} />

      {hasError || insync ? (
        <span className="bd-origin-ring" />
      ) : (
        <>
          {behind > 0 ? (
            <span
              className="bd-bar bd-behind"
              style={{
                right: "50%",
                width: (Math.min(behind, SCALE) / SCALE) * 50 + "%",
              }}
            >
              <span className="bd-cap bd-cap-l" />
              <span className="bd-lbl bd-lbl-l">↓{behind}</span>
            </span>
          ) : null}
          {ahead > 0 ? (
            <span
              className="bd-bar bd-ahead"
              style={{
                left: "50%",
                width: (Math.min(ahead, SCALE) / SCALE) * 50 + "%",
              }}
            >
              <span className="bd-cap bd-cap-r" />
              <span className="bd-lbl bd-lbl-r">↑{ahead}</span>
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function Churn({ wt, hasError }: { wt: RepoWatchWorktree; hasError: boolean }) {
  const { add, del, has } = reviewChurnOf(wt);
  if (hasError || !has) {
    return (
      <div className="bd-churn">
        <span className="dash">—</span>
      </div>
    );
  }
  const tot = add + del || 1;
  return (
    <div className="bd-churn">
      <span className="bd-churn-nums">
        <span className="add">+{fmt(add)}</span>
        <span className="sl">/</span>
        <span className="del">−{fmt(del)}</span>
      </span>
      <span className="bd-cbar" title={`+${fmt(add)} −${fmt(del)}`}>
        <span className="g" style={{ width: (add / tot) * 100 + "%" }} />
        <span className="r" style={{ width: (del / tot) * 100 + "%" }} />
      </span>
    </div>
  );
}

const MAX_AVATARS = 2;

function Avatars({ agents }: { agents: RepoWatchAgentRef[] }) {
  if (agents.length === 0) {
    return (
      <div className="bd-agents">
        <span className="dash">—</span>
      </div>
    );
  }
  const shown = agents.slice(0, MAX_AVATARS);
  const overflow = agents.length - shown.length;
  return (
    <div
      className="bd-agents"
      title={agents.map((a) => `${agentHandle(a)} (${a.state ?? "—"})`).join("\n")}
    >
      {shown.map((a) => (
        <span
          key={agentHandle(a)}
          className={"bd-av" + (agentLive(a) ? " live" : "")}
        >
          {initials(a)}
        </span>
      ))}
      {overflow > 0 ? <span className="bd-av-more">+{overflow}</span> : null}
    </div>
  );
}

function Flag({
  ahead,
  behind,
  hasError,
}: {
  ahead: number;
  behind: number;
  hasError: boolean;
}) {
  if (hasError) {
    return <div className="bd-flag err">SCAN ERR</div>;
  }
  // Diverged (ahead AND behind) must be called out before the ahead-only case,
  // otherwise a branch that needs a rebase reads as a clean "AHEAD".
  if (ahead > 0 && behind > 0) {
    return <div className="bd-flag rebase">DIVERGED ▸</div>;
  }
  if (behind > 0) {
    return <div className="bd-flag rebase">REBASE ▸</div>;
  }
  if (ahead > 0) {
    return <div className="bd-flag ahead">AHEAD {ahead}</div>;
  }
  return <div className="bd-flag sync">IN SYNC</div>;
}
