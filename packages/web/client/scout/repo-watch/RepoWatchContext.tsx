/**
 * Repo Watch — CONTEXT side pane.
 *
 * The right-hand drill-down that fills when a worktree is selected in the Fleet
 * Table. Ported from the Claude Design handoff's `ContextPanel`, but bound
 * strictly to the real `/api/repo-watch` snapshot contract — the design's
 * fabricated bits (commit history, per-file +/− churn, attached-session roles)
 * are NOT present in our wire format and are not invented here. Instead:
 *
 *   · RECENT COMMITS → a single "LAST COMMIT" line (ago + short head sha)
 *   · per-file churn → a status badge + path (we have status, not +/−)
 *   · ATTACHED SESSIONS → inferred handles plus raw harness session ids
 *   · CHURN → parsed from branch/staged/unstaged shortstats into the same split
 *     bar + numerals the table uses; "working tree clean" otherwise
 *
 * Palette + fonts inherit from the `.rw-scope` ancestor (see ReposScreen), so
 * the panel tracks the table's warm / cool / mono tone for free. Styles live in
 * ./console.css under `.rw-ctx` / `.ctx-*`.
 */

import { useMemo, useState } from "react";
import "./console.css";
import { api } from "../../lib/api.ts";
import type {
  RepoWatchWorktree,
  RepoWatchProject,
  RepoWatchAgentRef,
} from "./types.ts";
import {
  agoFromMillis,
  agentHandle,
  agentLive,
  sessionHandle,
  fileStatusTone,
  fileStatusBadge,
  toneFg,
  toneBg,
  uniqueAgents,
  branchChurnOf,
  churnOf,
  reviewChurnOf,
  wtState,
  fmt,
} from "./ui.ts";
import { BranchLabel } from "./parts.tsx";

/* Derive the header state tag from real status fields. */
function stateTag(wt: RepoWatchWorktree): { label: string; cls: string } {
  if (wt.error != null) return { label: "SCAN ERR", cls: "err" };
  if (wt.status.conflicts > 0) return { label: "CONFLICT", cls: "conflict" };
  if (!wt.status.clean) return { label: "DIRTY", cls: "dirty" };
  return { label: "CLEAN", cls: "clean" };
}

function stateWord(a: RepoWatchAgentRef): string {
  const s = (a.state ?? "").toLowerCase();
  if (s === "active") return "ACTIVE";
  if (s === "idle") return "IDLE";
  if (s === "waiting") return "WAITING";
  return "—";
}

/* Split a path into directory prefix + filename for the FILES CHANGED rows. */
function splitPath(p: string): { dir: string; file: string } {
  const i = p.lastIndexOf("/");
  if (i < 0) return { dir: "", file: p };
  return { dir: p.slice(0, i + 1), file: p.slice(i + 1) };
}

function statusSummary(wt: RepoWatchWorktree): string {
  if (wt.status.clean) return "clean";
  return `staged ${wt.status.staged}, unstaged ${wt.status.unstaged}, untracked ${wt.status.untracked}, conflicts ${wt.status.conflicts}, changed files ${wt.status.changedFiles}`;
}

function repoAskBody(
  request: string,
  worktree: RepoWatchWorktree,
  project: RepoWatchProject,
): string {
  const lines = [
    "Operator request:",
    request,
    "",
    "Repo Watch context:",
    `- Project: ${project.name}`,
    `- Project root: ${project.root}`,
    `- Project attention: ${project.attention}`,
    `- Worktree: ${worktree.path}`,
    `- Branch: ${worktree.branch.name ?? worktree.branch.head ?? "detached"}`,
  ];
  if (worktree.branch.upstream) {
    lines.push(`- Upstream: ${worktree.branch.upstream}`);
  }
  lines.push(
    `- Drift: ahead ${worktree.branch.ahead}, behind ${worktree.branch.behind}`,
    `- Status: ${statusSummary(worktree)}`,
  );
  const branchChurn = branchChurnOf(worktree);
  const worktreeChurn = churnOf(worktree);
  if (branchChurn.has) {
    lines.push(`- Branch churn: +${branchChurn.add} -${branchChurn.del}`);
  }
  if (worktreeChurn.has) {
    lines.push(`- Working-tree churn: +${worktreeChurn.add} -${worktreeChurn.del}`);
  }
  if (worktree.attentionReasons.length > 0) {
    lines.push(`- Attention reasons: ${worktree.attentionReasons.join("; ")}`);
  }
  if (worktree.status.files.length > 0) {
    const files = worktree.status.files
      .slice(0, 8)
      .map((file) => `${file.status}: ${file.path}`)
      .join(", ");
    lines.push(`- Changed files: ${files}`);
  }
  return lines.join("\n");
}

export default function RepoWatchContext({
  worktree,
  project,
  generatedAt,
}: {
  worktree: RepoWatchWorktree | null;
  project: RepoWatchProject | null;
  generatedAt: number;
}) {
  const [askDraft, setAskDraft] = useState("");
  const [askTarget, setAskTarget] = useState("scout");
  const [askPending, setAskPending] = useState(false);
  const [askStatus, setAskStatus] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const agents = useMemo(() => worktree ? uniqueAgents(worktree) : [], [worktree]);
  const agentTargets = useMemo(() => agents.slice(0, 8), [agents]);
  const activeTargetLabel = useMemo(() => {
    if (askTarget === "scout") return "Scout";
    const agentId = askTarget.replace(/^agent:/, "");
    const agent = agentTargets.find((candidate) => candidate.id === agentId);
    return agent ? agentHandle(agent) : "Agent";
  }, [agentTargets, askTarget]);

  async function submitAsk() {
    const trimmed = askDraft.trim();
    if (!trimmed || askPending || !worktree || !project) return;
    setAskPending(true);
    setAskStatus(null);
    setAskError(null);
    try {
      const body = repoAskBody(trimmed, worktree, project);
      if (askTarget === "scout") {
        await api("/api/send", {
          method: "POST",
          body: JSON.stringify({ body }),
        });
        setAskStatus("Sent to Scout");
      } else {
        const agentId = askTarget.replace(/^agent:/, "");
        await api("/api/ask", {
          method: "POST",
          body: JSON.stringify({
            body,
            targetAgentId: agentId,
            targetLabel: agentId,
            metadata: {
              source: "repo-watch",
              originSurface: "repo-watch",
              handoffKind: "repo-watch-agent-ask",
              targetAgentId: agentId,
            },
          }),
        });
        setAskStatus(`Sent to ${activeTargetLabel}`);
      }
      setAskDraft("");
    } catch (error) {
      setAskError(error instanceof Error ? error.message : String(error));
    } finally {
      setAskPending(false);
    }
  }

  if (!worktree || !project) {
    return (
      <aside className="rw-ctx" aria-label="Worktree detail">
        <div className="rw-ctx-empty">
          <span className="eb">CONTEXT · WORKTREE</span>
          <span className="msg">Select a worktree to inspect</span>
        </div>
      </aside>
    );
  }

  const wt = worktree;
  const b = wt.branch;

  // ATTACHED SESSIONS can run to hundreds of handles/sessions on a busy repo;
  // collapse to a handful by default and reveal the rest behind a toggle.
  const ATTACHED_COLLAPSED = 5;
  const attachedTotal = agents.length + wt.sessions.length;
  const attachedCollapsed = !sessionsExpanded && attachedTotal > ATTACHED_COLLAPSED;
  const shownAgents = attachedCollapsed ? agents.slice(0, ATTACHED_COLLAPSED) : agents;
  const shownSessions = attachedCollapsed
    ? wt.sessions.slice(0, Math.max(0, ATTACHED_COLLAPSED - shownAgents.length))
    : wt.sessions;
  const attachedHidden = attachedTotal - shownAgents.length - shownSessions.length;
  const tag = stateTag(wt);

  // Churn — parsed from real shortstats; branch + staged + unstaged.
  const branchChurn = branchChurnOf(wt);
  const worktreeChurn = churnOf(wt);
  const { add, del, has: hasChurn } = reviewChurnOf(wt);
  const churnTot = add + del || 1;

  // Breakdown chips (only those that carry a count).
  const breakdown: { label: string; n: number; cls?: string }[] = [
    { label: "staged", n: wt.status.staged },
    { label: "unstaged", n: wt.status.unstaged },
    { label: "untracked", n: wt.status.untracked },
    { label: "conflicts", n: wt.status.conflicts, cls: "conf" },
  ].filter((c) => c.n > 0);

  return (
    <aside className="rw-ctx" aria-label="Worktree detail">
      {/* ── header ── */}
      <div className="ctx-h">
        <div className="ctx-eyebrow">
          <span>CONTEXT · WORKTREE</span>
        </div>
        <div className="ctx-repo">
          <span className={"dot " + wtState(wt)} />
          <span className="rn">{project.name}</span>
          <span className={"ctx-state " + tag.cls}>{tag.label}</span>
        </div>
        <div className="ctx-branch">
          <BranchLabel branch={b} fallback={wt.name} />
        </div>
        <div className="ctx-path">
          {wt.path}
          {b.upstream ? <span className="ref"> · {b.upstream}</span> : null}
        </div>
      </div>

      {/* ── stat grid ── */}
      <div className="ctx-stats">
        <div>
          <div className={"v" + (b.ahead > 0 ? " mint" : " dim")}>↑{b.ahead}</div>
          <div className="k">AHEAD</div>
        </div>
        <div>
          <div className={"v" + (b.behind > 0 ? " amber" : " dim")}>↓{b.behind}</div>
          <div className="k">BEHIND</div>
        </div>
        <div>
          <div className={"v" + (wt.status.changedFiles > 0 ? "" : " dim")}>
            {wt.status.changedFiles}
          </div>
          <div className="k">FILES</div>
        </div>
      </div>

      {/* ── status breakdown chips ── */}
      {breakdown.length > 0 ? (
        <div className="ctx-breakdown">
          {breakdown.map((c) => (
            <span key={c.label} className={"ctx-chip" + (c.cls ? " " + c.cls : "")}>
              <span className="n">{c.n}</span>
              {c.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ctx-body">
        {/* ── attention / why ── */}
        {wt.attentionReasons.length > 0 ? (
          <div className="ctx-sec">
            <div className="ctx-sec-h">
              <span>ATTENTION</span>
              <span className="n">{wt.attentionReasons.length}</span>
            </div>
            <div className="ctx-why">
              {wt.attentionReasons.map((r, i) => (
                <span key={i} className="pill">
                  {r}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* ── scan error ── */}
        {wt.error ? (
          <div className="ctx-sec">
            <div className="ctx-sec-h">
              <span>SCAN ERROR</span>
            </div>
            <div className="ctx-err">{wt.error}</div>
          </div>
        ) : null}

        {/* ── churn ── */}
        <div className="ctx-sec">
          <div className="ctx-sec-h">
            <span>CHURN</span>
            <span className="n">{branchChurn.has ? "reviewable" : "working tree"}</span>
          </div>
          {hasChurn ? (
            <>
              <div className="ctx-churn">
                <span className="nums">
                  <span className="add">+{fmt(add)}</span>
                  <span className="sl">/</span>
                  <span className="del">−{fmt(del)}</span>
                </span>
                <span className="cbar" title={`+${fmt(add)} −${fmt(del)}`}>
                  <span className="g" style={{ width: (add / churnTot) * 100 + "%" }} />
                  <span className="r" style={{ width: (del / churnTot) * 100 + "%" }} />
                </span>
              </div>
              <span className="ctx-churn-clean">
                {branchChurn.has
                  ? `branch +${fmt(branchChurn.add)} −${fmt(branchChurn.del)}`
                  : null}
                {branchChurn.has && worktreeChurn.has ? " · " : null}
                {worktreeChurn.has
                  ? `working tree +${fmt(worktreeChurn.add)} −${fmt(worktreeChurn.del)}`
                  : null}
              </span>
            </>
          ) : (
            // No +/− shortstat doesn't mean clean: untracked-only, rename/mode,
            // or binary changes leave a dirty tree with zero line churn.
            <div className="ctx-churn-clean">
              {wt.status.clean ? "working tree clean" : "no line changes"}
            </div>
          )}
        </div>

        {/* ── files changed ── */}
        {wt.status.files.length > 0 ? (
          <div className="ctx-sec">
            <div className="ctx-sec-h">
              <span>FILES CHANGED</span>
              <span className="n">{wt.status.files.length}</span>
            </div>
            {wt.status.files.map((f) => {
              const tone = fileStatusTone(f.status);
              const { dir, file } = splitPath(f.path);
              return (
                <div className="ctx-fchg" key={f.path}>
                  <span
                    className="badge"
                    style={{ color: toneFg(tone), background: toneBg(tone) }}
                    title={f.status}
                  >
                    {fileStatusBadge(f.status)}
                  </span>
                  <span className="fp" title={f.path}>
                    <span className="dir">{dir}</span>
                    {file}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* ── last commit ── */}
        <div className="ctx-sec">
          <div className="ctx-sec-h">
            <span>LAST COMMIT</span>
          </div>
          <div className="ctx-commit">
            {wt.lastCommitAt != null || b.head ? (
              <>
                {b.head ? <span className="hash">{b.head.slice(0, 7)}</span> : null}
                <span className="t">{agoFromMillis(wt.lastCommitAt, generatedAt)} ago</span>
              </>
            ) : (
              <span className="none">no commit data</span>
            )}
          </div>
        </div>

        {/* ── attached sessions ── */}
        <div className="ctx-sec">
          <div className="ctx-sec-h">
            <span>ATTACHED SESSIONS</span>
            <span className="n">
              {agents.length} handle{agents.length === 1 ? "" : "s"}
              {wt.sessions.length > 0 ? ` · ${wt.sessions.length} session${wt.sessions.length === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {attachedTotal > 0 ? (
            <>
              {shownAgents.map((a) => (
                <div className="ctx-agent" key={agentHandle(a)}>
                  <span className={"d " + (agentLive(a) ? "on" : "off")} />
                  <span className="h">{agentHandle(a)}</span>
                  <span className="role">{stateWord(a)}</span>
                </div>
              ))}
              {shownSessions.map((session) => (
                <div className="ctx-agent" key={session.id}>
                  <span className="d off" />
                  <span className="h">{sessionHandle(session)}</span>
                  <span className="role">SESSION</span>
                </div>
              ))}
              {attachedTotal > ATTACHED_COLLAPSED ? (
                <button
                  type="button"
                  className="ctx-more"
                  onClick={() => setSessionsExpanded((v) => !v)}
                  aria-expanded={!attachedCollapsed}
                >
                  {attachedCollapsed ? `+${attachedHidden} more` : "Show less"}
                </button>
              ) : null}
            </>
          ) : (
            <div className="ctx-none">no attached sessions</div>
          )}
        </div>
      </div>

      {/* ── ask / handoff ── */}
      <div className="ctx-ask">
        <textarea
          value={askDraft}
          onChange={(event) => {
            setAskDraft(event.currentTarget.value);
            setAskStatus(null);
            setAskError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submitAsk();
            }
          }}
          disabled={askPending}
          rows={3}
          placeholder={askTarget === "scout" ? "Message Scout about this worktree" : "Message this agent about the worktree"}
        />
        <div className="ctx-ask-bar">
          <select
            value={askTarget}
            onChange={(event) => setAskTarget(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
            disabled={askPending}
            aria-label="Message target"
          >
            <option value="scout">Scout</option>
            {agentTargets.map((agent) => (
              <option key={agent.id} value={`agent:${agent.id}`}>
                {agentHandle(agent)}
              </option>
            ))}
          </select>
          <button
            className="ctx-btn primary"
            type="button"
            disabled={askPending || askDraft.trim().length === 0}
            onClick={() => void submitAsk()}
          >
            {askPending ? "Sending" : "Send"}
          </button>
        </div>
        <div className="ctx-ask-foot">
          {askError ? (
            <span className="err">{askError}</span>
          ) : askStatus ? (
            <span className="ok">{askStatus}</span>
          ) : (
            <span>Repo Watch context included · {activeTargetLabel}</span>
          )}
          <button
            type="button"
            title="Copy worktree path"
            onClick={() => {
              void navigator.clipboard?.writeText(wt.path);
            }}
          >
            Copy path
          </button>
        </div>
      </div>
    </aside>
  );
}
