import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ExternalLink } from "lucide-react";
import { SlidePanel } from "../../components/SlidePanel/SlidePanel.tsx";
import { api } from "../../lib/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { timeAgo } from "../../lib/time.ts";
import { tailAttributionLabel } from "../../lib/tail-display.ts";
import { isAgentBusy } from "../../lib/agent-state.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import {
  contextBudgetBarWidth,
  deriveContextBudgetGauge,
} from "../../lib/context-budget.ts";
import { requestSessionCompaction } from "../../lib/session-compaction.ts";
import { updateLocation } from "../../lib/router.ts";
import { useScout } from "../../scout/Provider.tsx";
import type { ObserveData, ObserveFile, PlanDocument, PlanDocumentStepStatus, PlanDocumentsResponse, Route } from "../../lib/types.ts";
import { bashDisplaySpans, splitCdPrefix, tildeShortenPath } from "../../lib/bash-format.ts";
import { isEditableTarget } from "../../lib/keyboard-nav.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import { buildAgentLanePreview, filePreviewLabel } from "./agent-lane-preview.ts";
import {
  laneProfileRoute,
  laneSessionRoute,
  laneTraceRoute,
} from "./agent-lane-navigation.ts";
import {
  buildLaneSessionStats,
  buildLaneTouchedFiles,
  docExcerpt,
  laneProjectPath,
  laneRecentCommands,
  relatedLaneSessionDocuments,
  type LaneCommand,
} from "./agent-lane-detail.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import {
  laneContextLabel,
  lanePrimaryLabel,
} from "./agent-lanes-model.ts";
import { supportsRemoteCompaction } from "./session-compaction.ts";

/** The leading tonal mark for a touched-file row — a step of one hue: created
 *  is the accent step, modified the neutral step, read the faintest. */
const FILE_STATE_MARK: Record<string, string> = {
  created: "+",
  modified: "~",
  read: "○",
};

const PLAN_STEP_LABELS: Record<PlanDocumentStepStatus, string> = {
  blocked: "blocked",
  completed: "done",
  in_progress: "active",
  pending: "todo",
  unknown: "step",
};

const LANE_SHEET_SECTION_IDS = [
  "s-lane-sheet-vitals",
  "s-lane-sheet-runtime",
  "s-lane-sheet-files",
  "s-lane-sheet-commands",
  "s-lane-sheet-plans",
  "s-lane-sheet-docs",
] as const;
type LaneSheetSectionId = typeof LANE_SHEET_SECTION_IDS[number];

function isLaneSheetSectionId(value: string | null | undefined): value is LaneSheetSectionId {
  return Boolean(value && LANE_SHEET_SECTION_IDS.includes(value as LaneSheetSectionId));
}

function currentLaneSheetHash(): LaneSheetSectionId | null {
  if (typeof window === "undefined") return null;
  const value = window.location.hash.replace(/^#/, "");
  return isLaneSheetSectionId(value) ? value : null;
}

function fmtCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

/** Compact a count to a calm magnitude (15451636 → "15.5M", 48553 → "48.6k").
 *  Ports the calm study's `mag()` so the Tokens disclosure hint reads small. */
function mag(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return `${value}`;
}

/** Split a path into its directory prefix (with trailing slash) and basename,
 *  so the file row can dim the dir (rtl-ellipsis) and ink the leaf. */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { dir: "", base: path };
  return { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** A touched file enriched with the aggregate +adds / −dels from the trace's
 *  tool diffs, since ObserveFile carries no per-file diff stat of its own. */
type LaneFileEntry = ObserveFile & { add: number; del: number };

/** Sum the per-event diff add/del onto each touched file, keyed by basename so
 *  a relative tool arg and an absolute file path still line up. */
function laneFilesWithDiff(
  files: ObserveFile[],
  observe: ObserveData | null | undefined,
): LaneFileEntry[] {
  const diffByLeaf = new Map<string, { add: number; del: number }>();
  for (const event of observe?.events ?? []) {
    if (event.kind !== "tool" || !event.diff || !event.arg) continue;
    const leaf = event.arg.trim().split(/[\\/]/).filter(Boolean).pop();
    if (!leaf) continue;
    const acc = diffByLeaf.get(leaf) ?? { add: 0, del: 0 };
    acc.add += event.diff.add ?? 0;
    acc.del += event.diff.del ?? 0;
    diffByLeaf.set(leaf, acc);
  }
  return files.map((file) => {
    const leaf = file.path.split(/[\\/]/).filter(Boolean).pop() ?? file.path;
    const diff = diffByLeaf.get(leaf);
    return { ...file, add: diff?.add ?? 0, del: diff?.del ?? 0 };
  });
}

function fmtPath(value: string | null | undefined, max = 48): string {
  if (!value) return "—";
  if (value.length <= max) return value;
  return `…${value.slice(-(max - 1))}`;
}

/** POST a reveal request so the OS file browser jumps to a local path. */
async function revealLocalPath(input: {
  path: string;
  basePath?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}) {
  await api<{ ok: true; path: string }>("/api/local-path/reveal", {
    method: "POST",
    body: JSON.stringify({
      path: input.path,
      ...(input.basePath ? { basePath: input.basePath } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
  });
}

/** Resolve a (possibly relative) path against the session cwd, the same way the
 *  observe trace does, so open/reveal target the real file on disk. */
function resolveLanePath(path: string, basePath: string | null | undefined): string {
  if (path.startsWith("/") || path.startsWith("~/")) return path;
  return basePath ? `${basePath.replace(/\/$/u, "")}/${path}` : path;
}

/** A small hover-revealed copy target — copies the FULL value even when the row
 *  shows a truncation, flashes a check. Mirrors the lane card's CopyDot so copy
 *  reads the same everywhere. */
function SheetCopy({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  const onCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void copyTextToClipboard(value).then((ok) => {
        if (!ok) return;
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1100);
      });
    },
    [value],
  );
  return (
    <button
      type="button"
      className={`s-lane-sheet-copy${copied ? " s-lane-sheet-copy--done" : ""}`}
      onClick={onCopy}
      title={copied ? "Copied" : `Copy ${label}`}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
    >
      {copied ? (
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M2.5 6.2 4.8 8.5 9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <rect x="3.4" y="3.4" width="5.8" height="5.8" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M2.4 7.2V2.8c0-.4.3-.7.7-.7h4" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

/** Reveal-in-OS button for a local path (same affordance as the observe trace). */
function RevealButton({
  path,
  basePath,
  agentId,
  sessionId,
  label,
}: {
  path: string;
  basePath?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  label: string;
}) {
  return (
    <button
      type="button"
      className="s-lane-sheet-reveal"
      title={`Reveal ${label} in OS`}
      aria-label={`Reveal ${label} in OS`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void revealLocalPath({ path, basePath, agentId, sessionId }).catch((error) =>
          console.warn("Failed to reveal local path", error),
        );
      }}
    >
      <ExternalLink size={11} strokeWidth={1.6} />
    </button>
  );
}

/** Section header — a label + optional count, a hairline rule that fills the
 *  remaining width, and optional inline action buttons on the right. Ports the
 *  studio's SecHead so every section reads as a titled rule, not a bare h3. */
function SheetSecHead({
  id,
  label,
  count,
  actions,
}: {
  id?: string;
  label: string;
  count?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="s-lane-sheet-sechead" id={id}>
      <span className="s-lane-sheet-sechead-label">{label}</span>
      {count != null && count !== false && (
        <span className="s-lane-sheet-sechead-count">{count}</span>
      )}
      <span className="s-lane-sheet-sechead-rule" aria-hidden="true" />
      {actions && <span className="s-lane-sheet-sechead-actions">{actions}</span>}
    </div>
  );
}

/** A small bordered pill action button — the studio's `.ghost`. `primary` adds
 *  the green-tinted treatment for the lead action. */
function SheetGhost({
  children,
  onClick,
  primary = false,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`s-lane-sheet-ghost${primary ? " s-lane-sheet-ghost--primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** One runtime fact: label · value (ellipsised) · hover copy/reveal targets. The
 *  display can be truncated while copy/reveal carry the full value. */
function SheetFact({
  label,
  value,
  title,
  copy,
  reveal,
}: {
  label: string;
  value: string;
  title?: string;
  copy?: string | null;
  reveal?: { path: string; basePath?: string | null; agentId?: string | null; sessionId?: string | null };
}) {
  return (
    <div className="s-lane-sheet-meta-row">
      <dt>{label}</dt>
      <dd className="s-lane-sheet-fact">
        <span className="s-lane-sheet-fact-val" title={title ?? value}>{value}</span>
        {reveal && <RevealButton {...reveal} label={label} />}
        {copy && <SheetCopy value={copy} label={label} />}
      </dd>
    </div>
  );
}

/** A touched-file row in the study's flat `.frow` treatment: a leading tonal
 *  mark, the path split into dim dir (rtl-ellipsis) + ink base, a trailing
 *  +adds/−dels, and hover open-in-diff / reveal / copy. No card fill — the row
 *  highlights only on hover. JUMPS (open in Scout · reveal in OS) and copies. */
function SheetFileRow({
  file,
  basePath,
  agentId,
  sessionId,
  onOpen,
}: {
  file: LaneFileEntry;
  basePath: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  onOpen: (path: string) => void;
}) {
  const label = filePreviewLabel(file);
  const full = file.path;
  const resolved = resolveLanePath(full, basePath);
  const { dir, base } = splitPath(full);
  const hasDiff = file.add > 0 || file.del > 0;
  return (
    <div className="s-lane-sheet-frow" title={full}>
      <span className={`s-lane-sheet-fstate s-lane-sheet-fstate--${file.state}`} aria-hidden="true">
        {FILE_STATE_MARK[file.state] ?? "○"}
      </span>
      <span className="s-lane-sheet-fpath">
        {dir && <span className="s-lane-sheet-fdir">{dir}</span>}
        <span className="s-lane-sheet-fbase">{base}</span>
      </span>
      {hasDiff && (
        <span className="s-lane-sheet-fdiff">
          {file.add > 0 && <span className="s-lane-sheet-file-add">+{file.add}</span>}
          {file.del > 0 && <span className="s-lane-sheet-file-del">−{file.del}</span>}
        </span>
      )}
      <span className="s-lane-sheet-frow-acts">
        <button
          type="button"
          className="s-lane-sheet-rowact"
          title={`Open ${label} in diff`}
          aria-label={`Open ${label} in diff`}
          onClick={() => onOpen(resolved)}
        >
          <ExternalLink size={11} strokeWidth={1.6} />
        </button>
        <RevealButton path={full} basePath={basePath} agentId={agentId} sessionId={sessionId} label={label} />
        <SheetCopy value={full} label="file path" />
      </span>
    </div>
  );
}

/** One recent shell command in the study's flat `.crow` density: a leading
 *  prompt mark, single-line ellipsised text (keeping the observe-trace bash-span
 *  coloring), an optional dim right-aligned outcome, and hover copy. */
function LaneCommandRow({ entry }: { entry: LaneCommand }) {
  const { dir, rest } = splitCdPrefix(tildeShortenPath(entry.command));
  const spans = bashDisplaySpans(rest || entry.command);
  return (
    <div className="s-lane-sheet-crow" title={entry.command}>
      <span className="s-lane-sheet-cmark" aria-hidden="true">❯</span>
      <span className="s-lane-sheet-ctext">
        {dir && <span className="s-lane-sheet-bash-dir">{dir}/</span>}
        {spans.map((span, index) => (
          <span
            key={index}
            className={`s-lane-sheet-bash-${span.tier}${span.known ? " s-lane-sheet-bash-prog--known" : ""}${span.flag ? " s-lane-sheet-bash-flag" : ""}`}
          >
            {index > 0 ? " " : ""}{span.text}
          </span>
        ))}
      </span>
      {entry.outcome && <span className="s-lane-sheet-cresult">{entry.outcome}</span>}
      <span className="s-lane-sheet-crow-acts">
        <SheetCopy value={entry.command} label="command" />
      </span>
    </div>
  );
}

/** A calm, full-width disclosure (caret · label · right-aligned hint), collapsed
 *  by default. Ports the calm study's `Disclose` — Runtime + Tokens fold behind
 *  it so the panel reads at the floor and reveals detail in context. */
function SheetDisclose({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`s-lane-sheet-disc${open ? " s-lane-sheet-disc--open" : ""}`}>
      <button type="button" className="s-lane-sheet-disc-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`s-lane-sheet-disc-caret${open ? " s-lane-sheet-disc-caret--open" : ""}`} aria-hidden="true">›</span>
        <span className="s-lane-sheet-disc-label">{label}</span>
        {hint != null && hint !== false && <span className="s-lane-sheet-disc-hint">{hint}</span>}
      </button>
      {open && <div className="s-lane-sheet-disc-body">{children}</div>}
    </div>
  );
}

/** A flat plan card (NOT a bordered card): caret · title · done/total tally.
 *  When collapsed it previews the active step inline (▸); expanded it lists every
 *  step with status markers, then an "Open in Plans →" foot. Ports the calm
 *  study's `PlanRow`. */
function SheetPlanCard({ plan, onOpen }: { plan: PlanDocument; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const active = plan.steps.find((step) => step.status === "in_progress");
  return (
    <div className={`s-lane-sheet-plan${open ? " s-lane-sheet-plan--open" : ""}`}>
      <button type="button" className="s-lane-sheet-plan-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`s-lane-sheet-plan-caret${open ? " s-lane-sheet-plan-caret--open" : ""}`} aria-hidden="true">›</span>
        <span className="s-lane-sheet-plan-title" title={plan.title}>{plan.title}</span>
        <span className="s-lane-sheet-plan-tally">{done}/{plan.steps.length}</span>
      </button>
      {!open && active && (
        <div className="s-lane-sheet-plan-now" title={active.text}>
          <span className="s-lane-sheet-plan-now-mark" aria-hidden="true">▸</span>
          <span className="s-lane-sheet-plan-now-text">{active.text}</span>
        </div>
      )}
      {open && (
        <div className="s-lane-sheet-plan-steps">
          {plan.steps.map((step) => (
            <div key={step.id} className={`s-lane-sheet-pstep s-lane-sheet-pstep--${step.status}`}>
              <span className="s-lane-sheet-pstep-box" aria-hidden="true">
                {step.status === "completed" ? "✓" : step.status === "in_progress" ? "▸" : "○"}
              </span>
              <span className="s-lane-sheet-pstep-text">{step.text}</span>
            </div>
          ))}
          <div className="s-lane-sheet-plan-foot">
            <SheetGhost onClick={onOpen}>Open in Plans →</SheetGhost>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionDocumentCard({
  document,
  expanded,
  onToggle,
  onOpen,
}: {
  document: PlanDocument;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const excerpt = docExcerpt(document);
  const isPlan = document.steps.length > 0;

  return (
    <article className="s-lane-sheet-doc">
      <button
        type="button"
        className="s-lane-sheet-doc-head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="s-lane-sheet-doc-title">{document.title}</span>
        <span className="s-lane-sheet-doc-meta">
          {isPlan ? `${document.steps.length} steps` : filePreviewLabel(document.path)} · {timeAgo(document.updatedAt)}
        </span>
        {!expanded && excerpt && <span className="s-lane-sheet-doc-excerpt">{excerpt}</span>}
      </button>
      {expanded && (
        <div className="s-lane-sheet-doc-body">
          {document.summary && <p className="s-lane-sheet-doc-summary">{document.summary}</p>}
          {isPlan && document.steps.length > 0 && (
            <ol className="s-lane-sheet-doc-steps">
              {document.steps.map((step) => (
                <li
                  key={step.id}
                  className={`s-lane-sheet-doc-step s-lane-sheet-doc-step--${step.status}`}
                >
                  <span className="s-lane-sheet-doc-step-state">
                    {PLAN_STEP_LABELS[step.status]}
                  </span>
                  <span className="s-lane-sheet-doc-step-text">{step.text}</span>
                </li>
              ))}
            </ol>
          )}
          {(document.body || document.rawText) && (
            <pre className="s-lane-sheet-doc-pre">{document.body || document.rawText}</pre>
          )}
          <button type="button" className="s-lane-sheet-doc-open" onClick={onOpen}>
            Open in Plans
          </button>
        </div>
      )}
    </article>
  );
}

export function AgentLaneDetailSheet({
  lane,
  navigate,
  returnRoute,
  onClose,
  navigationEnabled = true,
  onPinProject,
  projectPinned = false,
}: {
  lane: AgentLane;
  navigate: (route: Route) => void;
  returnRoute: Route;
  onClose: () => void;
  /// Browser routes (session/profile/traces/plan documents) do not exist in the
  /// adapter-backed native embeds, which pass an inert navigate. When false,
  /// route-jumping affordances are hidden instead of dead-clicking.
  navigationEnabled?: boolean;
  /// Optional deck-pin handler for the lane's working directory. Threaded
  /// from the view so the detail sheet can promote the project to a pinned
  /// filter lane without leaving the sheet — same affordance surface as the
  /// session/profile/trace buttons.
  onPinProject?: (projectPath: string) => void;
  /// True when a project lane already covers this path. Disables the button
  /// and lets the label show "Project pinned" so the state is visible.
  projectPinned?: boolean;
}) {
  const { agent, observe, source, lastActiveAt } = lane;
  const { openFilePreview } = useScout();
  const working = useMemo(() => isAgentBusy(agent.state ?? null, agent), [agent]);
  const preview = useMemo(
    () => buildAgentLanePreview(observe, agent, { isLive: working }),
    [observe, agent, working],
  );
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [plans, setPlans] = useState<PlanDocument[]>([]);
  const [docs, setDocs] = useState<PlanDocument[]>([]);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [readOpen, setReadOpen] = useState(false);
  const [changedCopied, setChangedCopied] = useState(false);
  const [compactPending, setCompactPending] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<LaneSheetSectionId>("s-lane-sheet-vitals");
  const changedCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => {
    if (changedCopyTimer.current) clearTimeout(changedCopyTimer.current);
  }, []);

  const setLocationHash = useCallback((id: LaneSheetSectionId) => {
    if (typeof window === "undefined") return;
    if (window.location.hash === `#${id}`) return;
    // Section anchors are real history entries (Back unwinds them); the
    // location store keeps the router's entry state instead of discarding it.
    updateLocation({ hash: id, replace: false });
  }, []);

  const scrollToSection = useCallback((id: LaneSheetSectionId) => {
    const body = bodyRef.current;
    const target = body?.querySelector<HTMLElement>(`#${id}`);
    if (!body || !target) return false;
    const bodyTop = body.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    // This panel owns its own scroll port. `scrollTo({ behavior: "smooth" })`
    // can update the selected anchor without moving that nested port in embedded
    // webviews, which makes the navigation look inert. Assigning `scrollTop`
    // moves the actual port synchronously and keeps the selected section and
    // visible content in lockstep.
    body.scrollTop = Math.max(0, body.scrollTop + targetTop - bodyTop);
    setActiveSectionId(id);
    return true;
  }, []);

  const jumpToSection = useCallback((
    event: ReactMouseEvent<HTMLAnchorElement>,
    id: LaneSheetSectionId,
  ) => {
    event.preventDefault();
    if (scrollToSection(id)) {
      setLocationHash(id);
    }
  }, [scrollToSection, setLocationHash]);

  const primaryLabel = lanePrimaryLabel(agent, source);
  const contextLabel = laneContextLabel(agent, source);
  const stats = useMemo(() => buildLaneSessionStats(lane), [lane]);
  const facts = lane.facts;
  // `working` (isAgentBusy) stays TRUE after a codex turn completes, so the
  // live/idle VISUAL must key off the actual turn phase when we have one — a
  // finished turn should read "last action", not "executing now". Fall back to
  // `working` only when there's no turn phase signal at all.
  const isLive = facts?.turn?.phase ? facts.turn.phase === "started" : working;
  // Project the lane is running in — feeds the "Pin project" CTA. The same
  // facts the runtime disclosure shows, so the button always lands on the
  // path the operator is staring at.
  const projectPath = laneProjectPath(lane);

  // The complete touched-file inventory (no arbitrary cap) enriched with the
  // per-file +adds/−dels summed from the trace's tool diffs, then split into the
  // changed (created/modified) and read groups the studio inventory shows.
  const fileGroups = useMemo(() => {
    const source = facts?.touchedFiles.length ? facts.touchedFiles : buildLaneTouchedFiles(observe, Infinity);
    const enriched = laneFilesWithDiff(source, observe);
    const created = enriched.filter((file) => file.state === "created");
    const modified = enriched.filter((file) => file.state === "modified");
    const read = enriched.filter((file) => file.state === "read");
    const changed = [...created, ...modified];
    return {
      created,
      modified,
      read,
      changed,
      totalAdd: changed.reduce((sum, file) => sum + file.add, 0),
      totalDel: changed.reduce((sum, file) => sum + file.del, 0),
    };
  }, [facts, observe]);
  const touchedCount = fileGroups.changed.length + fileGroups.read.length;

  const commands = useMemo(() => laneRecentCommands(observe), [observe]);

  // Bulk-action payloads: every changed path, and the diff target for "open all".
  const changedPaths = useMemo(
    () => fileGroups.changed.map((file) => resolveLanePath(file.path, stats.cwd)).join("\n"),
    [fileGroups.changed, stats.cwd],
  );

  // Copy payloads for the section-header ghost actions (diagnostics block · the
  // recent command list), built from the same data the panel already renders.
  const diagnostics = useMemo(() => {
    const lines: string[] = [`agent: ${primaryLabel}`];
    const harness = agent.harness ?? stats.harness;
    const model = facts?.model ?? stats.model;
    if (harness || model || facts?.effort) {
      lines.push(`harness: ${[harness, model, facts?.effort].filter(Boolean).join(" · ")}`);
    }
    const branch = facts?.branch ?? stats.branch;
    if (branch) lines.push(`branch: ${branch}`);
    if (stats.cwd) lines.push(`cwd: ${stats.cwd}`);
    if (stats.sessionId) lines.push(`session: ${stats.sessionId}`);
    if (agent.harnessLogPath) lines.push(`transcript: ${agent.harnessLogPath}`);
    if (facts?.originator) lines.push(`origin: ${facts.originator}`);
    return lines.join("\n");
  }, [agent, facts, primaryLabel, stats]);

  const allCommands = useMemo(
    () => commands.map((entry) => entry.command).join("\n"),
    [commands],
  );

  const copyDiagnostics = useCallback(() => {
    void copyTextToClipboard(diagnostics);
  }, [diagnostics]);

  const copyAllCommands = useCallback(() => {
    void copyTextToClipboard(allCommands);
  }, [allCommands]);

  const openAllInDiff = useCallback(() => {
    for (const file of fileGroups.changed) {
      openFilePreview(resolveLanePath(file.path, stats.cwd));
    }
  }, [fileGroups.changed, stats.cwd, openFilePreview]);

  const copyChanged = useCallback(() => {
    if (!changedPaths) return;
    void copyTextToClipboard(changedPaths).then((ok) => {
      if (!ok) return;
      setChangedCopied(true);
      if (changedCopyTimer.current) clearTimeout(changedCopyTimer.current);
      changedCopyTimer.current = setTimeout(() => setChangedCopied(false), 1100);
    });
  }, [changedPaths]);

  const usage = facts?.usage ?? stats.usage;

  // The raw token totals — rendered as the Cluster's demoted secondary "dials"
  // (short lowercase labels), no longer a bordered card grid.
  const usageCards = useMemo(() => {
    if (!usage) return [];
    return [
      { label: "in", value: usage.inputTokens },
      { label: "out", value: usage.outputTokens },
      { label: "cache rd", value: usage.cacheReadInputTokens },
      { label: "cache wr", value: usage.cacheCreationInputTokens },
      { label: "total", value: usage.totalTokens },
      { label: "reasoning", value: usage.reasoningOutputTokens },
    ].filter((entry) => typeof entry.value === "number");
  }, [usage]);

  const contextGauge = useMemo(
    () => deriveContextBudgetGauge(usage, {
      model: facts?.model ?? stats.model,
      adapterType: agent.harness ?? stats.harness,
    }),
    [usage, facts?.model, stats.model, agent.harness, stats.harness],
  );

  const canCompactContext = Boolean(
    facts?.compaction?.eligible
    && supportsRemoteCompaction(agent.harness ?? stats.harness)
    && stats.sessionId,
  );

  const runCompaction = useCallback(async () => {
    if (!canCompactContext || compactPending) return;
    setCompactPending(true);
    setCompactError(null);
    try {
      const result = await requestSessionCompaction({
        harness: agent.harness ?? stats.harness,
        sessionId: stats.sessionId,
        transcriptPath: agent.harnessLogPath,
        agentId: agent.id,
      });
      if (!result.ok || !result.delivered) {
        setCompactError(result.error ?? "Compaction was not delivered to the harness");
      }
    } catch (error) {
      setCompactError(error instanceof Error ? error.message : "Compaction request failed");
    } finally {
      setCompactPending(false);
    }
  }, [
    agent.harness,
    agent.harnessLogPath,
    agent.id,
    canCompactContext,
    compactPending,
    stats.harness,
    stats.sessionId,
  ]);

  // CADENCE — a calm one-line readout (events · tools · age). There is no real
  // per-bucket activity time-series in the data model, so we deliberately ship
  // the restrained one-liner instead of a fabricated sparkline.
  const cadenceAge = lastActiveAt ? timeAgo(lastActiveAt) : null;

  const sessionRoute = useMemo(() => laneSessionRoute(lane), [lane]);
  const profileRoute = useMemo(() => laneProfileRoute(lane), [lane]);
  const traceRoute = useMemo(() => laneTraceRoute(lane), [lane]);

  const openSession = useCallback(() => {
    if (!navigationEnabled || !sessionRoute) return;
    openContent(navigate, sessionRoute, { returnTo: returnRoute });
    onClose();
  }, [navigate, navigationEnabled, onClose, returnRoute, sessionRoute]);

  const openProfile = useCallback(() => {
    if (!navigationEnabled) return;
    if (profileRoute) {
      openContent(navigate, profileRoute, { returnTo: returnRoute });
      onClose();
      return;
    }
    openSession();
  }, [navigate, navigationEnabled, onClose, openSession, profileRoute, returnRoute]);

  const openTraces = useCallback(() => {
    if (!navigationEnabled || !traceRoute) return;
    openContent(navigate, traceRoute, { returnTo: returnRoute });
    onClose();
  }, [navigate, navigationEnabled, onClose, returnRoute, traceRoute]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      switch (event.key.toLowerCase()) {
        case "o":
          event.preventDefault();
          openSession();
          break;
        case "t":
          event.preventDefault();
          openTraces();
          break;
        case "p":
          if (!profileRoute) return;
          event.preventDefault();
          openProfile();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openProfile, openSession, openTraces, profileRoute]);

  const openDocument = useCallback(
    (documentId: string) => {
      if (!navigationEnabled) return;
      navigate({ view: "ops", mode: "advisor", planDocumentId: documentId });
      onClose();
    },
    [navigate, navigationEnabled, onClose],
  );

  useEffect(() => {
    let cancelled = false;
    setDocumentsLoaded(false);
    void api<PlanDocumentsResponse>("/api/plan-documents")
      .then((inventory) => {
        if (cancelled) return;
        const related = relatedLaneSessionDocuments(inventory.documents, lane);
        setPlans(related.plans);
        setDocs(related.docs);
        setDocumentsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPlans([]);
        setDocs([]);
        setDocumentsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [lane.id]);

  useEffect(() => {
    const syncFromHash = () => {
      const id = currentLaneSheetHash();
      if (!id) return;
      window.requestAnimationFrame(() => {
        scrollToSection(id);
      });
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, [lane.id, commands.length, scrollToSection]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let frame = 0;
    const updateActiveSection = () => {
      frame = 0;
      const sections = LANE_SHEET_SECTION_IDS
        .map((id) => body.querySelector<HTMLElement>(`#${id}`))
        .filter((section): section is HTMLElement => Boolean(section));
      if (sections.length === 0) return;
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) {
        const lastId = sections[sections.length - 1].id;
        if (isLaneSheetSectionId(lastId)) {
          setActiveSectionId(lastId);
        }
        return;
      }
      const activationTop = body.getBoundingClientRect().top + 18;
      const next = sections.reduce<HTMLElement>((current, section) => (
        section.getBoundingClientRect().top <= activationTop ? section : current
      ), sections[0]);
      if (isLaneSheetSectionId(next.id)) {
        setActiveSectionId(next.id);
      }
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveSection);
    };
    updateActiveSection();
    body.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      body.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [commands.length, documentsLoaded, plans.length, docs.length]);

  return (
    <SlidePanel
      open
      onClose={onClose}
      side="right"
      owner="openscout.agent-lane"
      resizable
      defaultSize={720}
      minSize={420}
      maxSize={960}
      scrollLock
      ariaLabel={`${primaryLabel} lane detail`}
      className="s-lane-sheet"
    >
      <div className="s-slide-header s-lane-sheet-header">
        <AgentAvatar
          agent={agent}
          placement="row"
          size={28}
          presence={false}
          className="s-agent-lane-avatar"
        />
        <div className="s-lane-sheet-header-copy">
          <div className="s-lane-sheet-title">{primaryLabel}</div>
          <div className="s-lane-sheet-sub">
            {contextLabel} · {lastActiveAt ? timeAgo(lastActiveAt) : "idle"}
          </div>
        </div>
        <span className="s-slide-spacer" />
        {/* CTAs ride the header's horizontal line, aligned with the harness
            brand mark: jump into the lane session first; profile/trace only
            when the agent is registered in the directory. */}
        <div className="s-lane-sheet-header-cta">
          <HarnessMark
            harness={agent.harness ?? stats.harness}
            size={18}
            className={`s-lane-sheet-hmark${isLive ? " s-lane-sheet-hmark--working" : ""}`}
          />
          {navigationEnabled ? (
            <>
              <SheetGhost primary onClick={openSession} disabled={!sessionRoute}>
                Open session
              </SheetGhost>
              {profileRoute ? (
                <SheetGhost onClick={openProfile}>Agent profile</SheetGhost>
              ) : null}
              <SheetGhost onClick={openTraces} disabled={!traceRoute}>
                Traces
              </SheetGhost>
            </>
          ) : null}
          {/* Pin project — deck action, not a route jump; stays visible in
              native embeds too (local-storage mutation is independent of the
              route surface). Label flips to "Project pinned" once the same
              project lane is already present so the state isn't a silent no-op. */}
          {projectPath ? (
            <SheetGhost
              onClick={() => onPinProject?.(projectPath)}
              disabled={projectPinned || !onPinProject}
            >
              <span title={projectPath}>
                {projectPinned ? "Project pinned" : "Pin project"}
              </span>
            </SheetGhost>
          ) : null}
        </div>
        <button type="button" className="s-slide-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <nav className="s-lane-sheet-anchors" aria-label="Jump to section">
        <a
          href="#s-lane-sheet-vitals"
          className={`s-lane-sheet-anchor${activeSectionId === "s-lane-sheet-vitals" ? " s-lane-sheet-anchor--active" : ""}`}
          aria-current={activeSectionId === "s-lane-sheet-vitals" ? "location" : undefined}
          onClick={(event) => jumpToSection(event, "s-lane-sheet-vitals")}
        >
          Vitals
        </a>
        <a
          href="#s-lane-sheet-runtime"
          className={`s-lane-sheet-anchor${activeSectionId === "s-lane-sheet-runtime" ? " s-lane-sheet-anchor--active" : ""}`}
          aria-current={activeSectionId === "s-lane-sheet-runtime" ? "location" : undefined}
          onClick={(event) => jumpToSection(event, "s-lane-sheet-runtime")}
        >
          Runtime
        </a>
        <a
          href="#s-lane-sheet-files"
          className={`s-lane-sheet-anchor${activeSectionId === "s-lane-sheet-files" ? " s-lane-sheet-anchor--active" : ""}`}
          aria-current={activeSectionId === "s-lane-sheet-files" ? "location" : undefined}
          onClick={(event) => jumpToSection(event, "s-lane-sheet-files")}
        >
          Files{touchedCount > 0 && <span className="s-lane-sheet-anchor-n">{touchedCount}</span>}
        </a>
        {commands.length > 0 && (
          <a
            href="#s-lane-sheet-commands"
            className={`s-lane-sheet-anchor${activeSectionId === "s-lane-sheet-commands" ? " s-lane-sheet-anchor--active" : ""}`}
            aria-current={activeSectionId === "s-lane-sheet-commands" ? "location" : undefined}
            onClick={(event) => jumpToSection(event, "s-lane-sheet-commands")}
          >
            Commands<span className="s-lane-sheet-anchor-n">{commands.length}</span>
          </a>
        )}
        <a
          href="#s-lane-sheet-plans"
          className={`s-lane-sheet-anchor${activeSectionId === "s-lane-sheet-plans" ? " s-lane-sheet-anchor--active" : ""}`}
          aria-current={activeSectionId === "s-lane-sheet-plans" ? "location" : undefined}
          onClick={(event) => jumpToSection(event, "s-lane-sheet-plans")}
        >
          Plans
        </a>
        <a
          href="#s-lane-sheet-docs"
          className={`s-lane-sheet-anchor${activeSectionId === "s-lane-sheet-docs" ? " s-lane-sheet-anchor--active" : ""}`}
          aria-current={activeSectionId === "s-lane-sheet-docs" ? "location" : undefined}
          onClick={(event) => jumpToSection(event, "s-lane-sheet-docs")}
        >
          Docs
        </a>
        {isLive && facts?.turn && (
          <span className="s-lane-sheet-anchorbar-turn">
            turn {facts.turn.phase}{facts.turn.index ? ` · #${facts.turn.index}` : ""}
          </span>
        )}
      </nav>

      <div
        ref={bodyRef}
        className={`s-slide-body s-lane-sheet-body${isLive ? " s-lane-sheet-body--working" : " s-lane-sheet-body--idle"}`}
      >
        {/* VITALS — the cockpit hero: alive · how full · how busy, in one look.
            A flat section (soft emerald top wash) holding the live action well,
            the context-budget gauge, and a calm one-line cadence readout. When
            the agent is idle the whole section is stilled (--idle): no wash, no
            pulse, the live dot goes inert and the well reframes to "last action". */}
        <section
          id="s-lane-sheet-vitals"
          className={`s-lane-sheet-section s-lane-sheet-vitals${isLive ? "" : " s-lane-sheet-vitals--idle"}`}
        >
          {preview && (
            <div className="s-lane-sheet-vitals-now">
              <div className="s-lane-sheet-vitals-now-top">
                <span className="s-lane-sheet-vitals-live" aria-hidden="true">
                  <span className="s-lane-sheet-vitals-live-dot" />
                  <span className="s-lane-sheet-vitals-live-ring" />
                </span>
                <span className="s-lane-sheet-vitals-now-label">{isLive ? "executing now" : "last action"}</span>
                {isLive && facts?.turn && (
                  <span className="s-lane-sheet-vitals-now-turn">
                    turn {facts.turn.phase}{facts.turn.index ? ` · #${facts.turn.index}` : ""}
                  </span>
                )}
              </div>
              <div className="s-lane-sheet-vitals-well">
                {preview.headlineFrom === "user" ? (
                  <span className="s-lane-sheet-vitals-prompt" aria-hidden="true">←</span>
                ) : preview.headlineFrom === "agent" ? (
                  <span className="s-lane-sheet-vitals-prompt" aria-hidden="true">→</span>
                ) : (
                  <span className="s-lane-sheet-vitals-prompt s-lane-sheet-vitals-prompt--cmd" aria-hidden="true">❯</span>
                )}
                <span className="s-lane-sheet-vitals-cmd" title={preview.headFull}>{preview.headline}</span>
                {isLive && <span className="s-lane-sheet-vitals-caret" aria-hidden="true" />}
                <span className="s-lane-sheet-vitals-now-acts">
                  {navigationEnabled && (
                    <button type="button" className="s-lane-sheet-reveal" title="Open trace at this step" aria-label="Open trace" onClick={openTraces}>
                      <ExternalLink size={11} strokeWidth={1.6} />
                    </button>
                  )}
                  {preview.headFull && preview.headFull !== preview.headline && (
                    <SheetCopy value={preview.headFull} label="current action" />
                  )}
                </span>
              </div>
            </div>
          )}

          {contextGauge && (
            <div className={`s-lane-sheet-vitals-gauge${contextGauge.overLimit ? " s-lane-sheet-vitals-gauge--over" : ""}`}>
              <div className="s-lane-sheet-vitals-gauge-top">
                <span className="s-lane-sheet-vitals-gauge-label">context</span>
                <span className="s-lane-sheet-vitals-gauge-read">
                  <b>{contextGauge.usedLabel}</b>
                  <span className="s-lane-sheet-vitals-gauge-of"> / {contextGauge.budgetLabel}</span>
                  <span className="s-lane-sheet-vitals-gauge-unit"> tokens</span>
                  <span className="s-lane-sheet-vitals-gauge-pct">
                    {contextGauge.pct}%
                    {contextGauge.overLimit ? " over" : ""}
                  </span>
                </span>
                {canCompactContext && (
                  <button
                    type="button"
                    className="s-lane-sheet-vitals-compact"
                    onClick={() => void runCompaction()}
                    disabled={compactPending}
                    title="Force a context compaction on this live session"
                  >
                    {compactPending ? "Compacting…" : "Compact context"}
                  </button>
                )}
              </div>
              <div
                className="s-lane-sheet-vitals-gaugebar"
                role="meter"
                aria-label="context budget"
                aria-valuenow={contextGauge.pct}
                aria-valuemin={0}
                aria-valuemax={Math.max(100, contextGauge.pct)}
              >
                <span
                  className="s-lane-sheet-vitals-gaugebar-fill"
                  style={{ width: `${contextBudgetBarWidth(contextGauge)}%` }}
                >
                  <span className="s-lane-sheet-vitals-gaugebar-edge" aria-hidden="true" />
                </span>
                {[25, 50, 75].map((tick) => (
                  <span key={tick} className="s-lane-sheet-vitals-gaugebar-tick" style={{ left: `${tick}%` }} aria-hidden="true" />
                ))}
              </div>
              {compactError && (
                <div className="s-lane-sheet-vitals-compact-error" role="status">{compactError}</div>
              )}
              {facts?.compaction?.lastCompactedSummary && (
                <div className="s-lane-sheet-vitals-compact-note">
                  last compaction · {facts.compaction.lastCompactedSummary}
                </div>
              )}
            </div>
          )}

          <div className="s-lane-sheet-vitals-cadence">
            <b>{fmtCount(stats.events)}</b> events · <b>{fmtCount(stats.tools)}</b> tools
            {cadenceAge ? <> · {cadenceAge}</> : null}
          </div>
        </section>

        <section id="s-lane-sheet-runtime" className="s-lane-sheet-section">
          <SheetDisclose label="Runtime" hint={[agent.harness ?? stats.harness, facts?.model ?? stats.model].filter(Boolean).join(" · ") || undefined}>
            <dl className="s-lane-sheet-meta">
              {/* model + harness live in the disclosure hint above, so the body
                  doesn't replay them — it carries the rest of the runtime facts. */}
              <SheetFact label="Effort" value={facts?.effort ?? "—"} />
              <SheetFact label="Branch" value={facts?.branch ?? stats.branch ?? "—"} copy={facts?.branch ?? stats.branch ?? null} />
              <SheetFact
                label="Working dir"
                value={fmtPath(stats.cwd)}
                title={stats.cwd ?? undefined}
                copy={stats.cwd ?? null}
                reveal={stats.cwd ? { path: stats.cwd, basePath: stats.cwd, agentId: agent.id, sessionId: stats.sessionId } : undefined}
              />
              <SheetFact
                label="Session"
                value={fmtPath(stats.sessionId, 36)}
                title={stats.sessionId ?? undefined}
                copy={stats.sessionId ?? null}
              />
              {agent.harnessLogPath && (
                <SheetFact
                  label="Transcript"
                  value={fmtPath(agent.harnessLogPath, 36)}
                  title={agent.harnessLogPath}
                  copy={agent.harnessLogPath}
                  reveal={{ path: agent.harnessLogPath, basePath: stats.cwd, agentId: agent.id, sessionId: stats.sessionId }}
                />
              )}
              <SheetFact label="Origin" value={facts?.originator ?? "—"} copy={facts?.originator ?? null} />
              <SheetFact
                label="Attribution"
                value={facts?.attribution ? tailAttributionLabel(facts.attribution) : "—"}
              />
              {facts?.currentTask && (
                <SheetFact label="Task" value={facts.currentTask} title={facts.currentTask} copy={facts.currentTask} />
              )}
            </dl>
            <div className="s-lane-sheet-disc-bar">
              <SheetGhost onClick={copyDiagnostics}>Copy diagnostics</SheetGhost>
            </div>
          </SheetDisclose>

          {usageCards.length > 0 && (
            <SheetDisclose
              label="Tokens"
              hint={typeof usage?.totalTokens === "number" ? mag(usage.totalTokens) : undefined}
            >
              <div className="s-lane-sheet-dials">
                {usageCards.map((entry) => (
                  <span key={entry.label} className="s-lane-sheet-dial">
                    <span className="s-lane-sheet-dial-value">{fmtCount(entry.value)}</span>
                    <span className="s-lane-sheet-dial-label">{entry.label}</span>
                  </span>
                ))}
              </div>
            </SheetDisclose>
          )}
        </section>

        <section id="s-lane-sheet-files" className="s-lane-sheet-section">
          <SheetSecHead
            label="Files"
            count={
              touchedCount > 0
                ? `${fileGroups.changed.length} changed · ${fileGroups.read.length} read`
                : undefined
            }
            actions={
              fileGroups.changed.length > 0 ? (
                <>
                  {(fileGroups.totalAdd > 0 || fileGroups.totalDel > 0) && (
                    <span className="s-lane-sheet-file-diff" aria-hidden="true">
                      {fileGroups.totalAdd > 0 && <span className="s-lane-sheet-file-add">+{fileGroups.totalAdd}</span>}
                      {fileGroups.totalDel > 0 && <span className="s-lane-sheet-file-del">−{fileGroups.totalDel}</span>}
                    </span>
                  )}
                  <SheetGhost onClick={copyChanged}>
                    {changedCopied ? "Copied" : "Copy changed"}
                  </SheetGhost>
                  <SheetGhost onClick={openAllInDiff}>Open all → diff</SheetGhost>
                </>
              ) : undefined
            }
          />
          {touchedCount === 0 ? (
            <div className="s-lane-sheet-empty">No files touched in this session yet.</div>
          ) : (
            <div className="s-lane-sheet-filegroups">
              {fileGroups.created.length > 0 && (
                <div className="s-lane-sheet-filegroup">
                  <div className="s-lane-sheet-fglabel">
                    <span className="s-lane-sheet-fgmark s-lane-sheet-fgmark--created" aria-hidden="true" />
                    new
                    <span className="s-lane-sheet-fgcount">{fileGroups.created.length}</span>
                  </div>
                  <div className="s-lane-sheet-files">
                    {fileGroups.created.map((file) => (
                      <SheetFileRow
                        key={file.path}
                        file={file}
                        basePath={stats.cwd}
                        agentId={agent.id}
                        sessionId={stats.sessionId}
                        onOpen={openFilePreview}
                      />
                    ))}
                  </div>
                </div>
              )}
              {fileGroups.modified.length > 0 && (
                <div className="s-lane-sheet-filegroup">
                  <div className="s-lane-sheet-fglabel">
                    <span className="s-lane-sheet-fgmark s-lane-sheet-fgmark--modified" aria-hidden="true" />
                    modified
                    <span className="s-lane-sheet-fgcount">{fileGroups.modified.length}</span>
                  </div>
                  <div className="s-lane-sheet-files">
                    {fileGroups.modified.map((file) => (
                      <SheetFileRow
                        key={file.path}
                        file={file}
                        basePath={stats.cwd}
                        agentId={agent.id}
                        sessionId={stats.sessionId}
                        onOpen={openFilePreview}
                      />
                    ))}
                  </div>
                </div>
              )}
              {fileGroups.read.length > 0 && (
                <div className="s-lane-sheet-filegroup">
                  <button
                    type="button"
                    className="s-lane-sheet-fglabel s-lane-sheet-fglabel--btn"
                    aria-expanded={readOpen}
                    onClick={() => setReadOpen((open) => !open)}
                  >
                    <span className={`s-lane-sheet-fgcaret${readOpen ? " s-lane-sheet-fgcaret--open" : ""}`} aria-hidden="true">›</span>
                    <span className="s-lane-sheet-fgmark s-lane-sheet-fgmark--read" aria-hidden="true" />
                    read
                    <span className="s-lane-sheet-fgcount">{fileGroups.read.length}</span>
                    {!readOpen && <span className="s-lane-sheet-fghint">collapsed</span>}
                  </button>
                  {readOpen && (
                    <div className="s-lane-sheet-files">
                      {fileGroups.read.map((file) => (
                        <SheetFileRow
                          key={file.path}
                          file={file}
                          basePath={stats.cwd}
                          agentId={agent.id}
                          sessionId={stats.sessionId}
                          onOpen={openFilePreview}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {commands.length > 0 && (
          <section id="s-lane-sheet-commands" className="s-lane-sheet-section">
            <SheetSecHead
              label="Commands"
              count="recent"
              actions={<SheetGhost onClick={copyAllCommands}>Copy all</SheetGhost>}
            />
            <div className="s-lane-sheet-cmds">
              {commands.map((entry) => (
                <LaneCommandRow key={entry.id} entry={entry} />
              ))}
            </div>
          </section>
        )}

        <section id="s-lane-sheet-plans" className="s-lane-sheet-section">
          <SheetSecHead
            label="Plans"
            count={documentsLoaded && plans.length > 0 ? plans.length : undefined}
          />
          {!documentsLoaded ? (
            <div className="s-lane-sheet-empty">Indexing plan documents…</div>
          ) : plans.length === 0 ? (
            <div className="s-lane-sheet-empty">No plans matched this session yet.</div>
          ) : (
            <div className="s-lane-sheet-plans">
              {plans.map((plan) => (
                <SheetPlanCard key={plan.id} plan={plan} onOpen={() => openDocument(plan.id)} />
              ))}
            </div>
          )}
        </section>

        <section id="s-lane-sheet-docs" className="s-lane-sheet-section">
          <SheetSecHead
            label="Docs"
            count={documentsLoaded && docs.length > 0 ? docs.length : undefined}
          />
          {!documentsLoaded ? (
            <div className="s-lane-sheet-empty">Indexing documents…</div>
          ) : docs.length === 0 ? (
            <div className="s-lane-sheet-empty">No related docs matched this session yet.</div>
          ) : (
            <div className="s-lane-sheet-docs">
              {docs.map((doc) => (
                <SessionDocumentCard
                  key={doc.id}
                  document={doc}
                  expanded={expandedDocId === doc.id}
                  onToggle={() => setExpandedDocId((current) => (current === doc.id ? null : doc.id))}
                  onOpen={() => openDocument(doc.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </SlidePanel>
  );
}
