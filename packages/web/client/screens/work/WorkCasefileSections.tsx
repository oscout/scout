import {
  Activity,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CirclePause,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Radio,
  Search,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useContextMenu } from "../../components/ContextMenu.tsx";
import { SessionHopMenu } from "../../components/SessionHopMenu.tsx";
import { renderWithMentions } from "../../lib/mentions.tsx";
import { routePath } from "../../lib/router.ts";
import { timeAgoWithSuffix } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import type { Route, WorkDetail, WorkMaterial, WorkMaterialContent } from "../../lib/types.ts";
import { workMaterialDiffTotal } from "../../../shared/api/work-materials.ts";
import { initialWorkBriefSummary, workTailRoute, workMaterialImageUrl } from "./work-detail-context.ts";
import { outlineRequest, type RequestLine } from "./work-request-outline.ts";
import "./work-casefile.css";

type Navigate = (r: Route) => void;

export function copyText(value: string): void {
  void navigator.clipboard?.writeText(value);
}

function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return [copied, () => setCopied(true)];
}

/** Every id, path and URL carries one. Copies the full value, never the head…tail. */
export function CopyMark({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, markCopied] = useCopied();
  return (
    <button
      type="button"
      className="s-wc-copy"
      data-copied={copied || undefined}
      title={copied ? "Copied" : `${label}: ${value}`}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        copyText(value);
        markCopied();
      }}
    >
      {copied ? <><Check size={11} strokeWidth={2} aria-hidden="true" />Copied</> : <Copy size={11} strokeWidth={1.8} aria-hidden="true" />}
    </button>
  );
}

/** A labelled button that confirms the copy in place. */
export function CopyButton({ value, children, icon, className = "s-wc-btn" }: { value: () => string; children: ReactNode; icon?: ReactNode; className?: string }) {
  const [copied, markCopied] = useCopied();
  return (
    <button type="button" className={className} onClick={() => { copyText(value()); markCopied(); }}>
      {copied ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : icon ?? <Copy size={12} strokeWidth={1.8} aria-hidden="true" />}
      <span>{copied ? "Copied" : children}</span>
    </button>
  );
}

/* ── formatting ──────────────────────────────────────────────────────────── */

export function clock(at: number, seconds = true): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 30 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

function shortId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function absoluteUrl(route: Route): string {
  return new URL(routePath(route), window.location.origin).toString();
}

function observedRuntime(detail: WorkDetail): { model: string | null; effort: string | null } {
  const flightId = detail.primaryInvocation?.flightId;
  const flights = flightId ? detail.allFlights.filter((f) => f.id === flightId) : detail.allFlights;
  for (const flight of flights) {
    for (const session of [...flight.sessions].reverse()) {
      const res = session.executionResolution;
      const model = res?.model?.observed ?? null;
      const effort = res?.reasoningEffort?.observed ?? null;
      if (model || effort) return { model, effort };
    }
  }
  return { model: null, effort: null };
}

function closingEvent(detail: WorkDetail) {
  return [...detail.timeline]
    .filter((item) => item.kind === "collaboration_event" && item.detailKind === "done")
    .sort((a, b) => b.at - a.at)[0] ?? null;
}

export function touchedMaterials(detail: WorkDetail): WorkMaterial[] {
  return (detail.inventory?.materials ?? []).filter((m) => m.status !== "observed");
}

/* ── masthead ────────────────────────────────────────────────────────────── */

const STATUS_ICON = { done: CircleCheck, waiting: CirclePause, review: CirclePause } as const;

export function WorkMasthead({
  detail,
  embedded,
  leading,
  tools,
  progressLink,
  onJson,
  cue,
  links,
}: {
  detail: WorkDetail;
  embedded: boolean;
  leading?: ReactNode;
  tools?: ReactNode;
  progressLink: () => string;
  onJson: () => void;
  cue: { eyebrow: string; title: string; body: string } | null;
  links: ReactNode;
}) {
  const done = detail.state === "done";
  const Icon = STATUS_ICON[detail.state as keyof typeof STATUS_ICON] ?? CircleDot;
  const ask = detail.primaryInvocation;
  const closing = closingEvent(detail);
  const closedAt = closing?.at ?? detail.lastMeaningfulAt;
  const harness = ask?.resolvedHarness ?? ask?.requestedHarness;
  const transport = ask?.resolvedTransport;
  const reviewRounds = detail.timeline.filter((item) => item.detailKind === "review_requested").length;
  const touched = touchedMaterials(detail).length;
  const acceptance = detail.acceptanceState && detail.acceptanceState !== "none" ? detail.acceptanceState.replace(/_/g, " ") : null;
  const facts = [
    detail.ownerName ?? detail.ownerId,
    harness ? (transport ? `${harness} over ${transport}` : harness) : null,
    done ? `${span(closedAt - detail.createdAt)} start to finish` : `open ${span(Date.now() - detail.createdAt)}`,
    reviewRounds > 0 ? `${reviewRounds} review round${reviewRounds === 1 ? "" : "s"}` : null,
    touched > 0 ? `${touched} file${touched === 1 ? "" : "s"} touched` : null,
    detail.priority ? `Priority ${detail.priority}` : null,
  ].filter(Boolean);

  return (
    <header className="s-wc-mast">
      <div className="s-wc-topbar">
        {leading}
        <span className="s-wc-kind">Work</span>
        <span className="s-wc-id-chip">
          <code>{detail.id}</code>
          <CopyMark value={detail.id} label="Copy work id" />
        </span>
        <span className="s-wc-spacer" />
        <CopyButton value={progressLink} icon={<Link2 size={12} strokeWidth={1.8} aria-hidden="true" />}>Copy progress link</CopyButton>
        {tools}
        <button type="button" className="s-wc-btn" onClick={onJson}>
          <Code2 size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>View JSON</span>
        </button>
        {embedded && (
          <>
            <span className="s-wc-top-sep" aria-hidden="true" />
            <a className="s-wc-btn-strong" href={`/work/${encodeURIComponent(detail.id)}`} target="_blank" rel="noreferrer">
              Open in Scout <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
            </a>
          </>
        )}
      </div>

      <h1 className="s-wc-title">{detail.title}</h1>

      <div className="s-wc-status">
        <span className="s-wc-status-plate" data-done={done || undefined}>
          <span className="s-wc-status-main">
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
            {detail.currentPhase}
          </span>
          {acceptance && (
            <span className="s-wc-status-sub">Acceptance <b>{acceptance}</b></span>
          )}
        </span>
        <span className="s-wc-status-meta">
          {done
            ? <>Closed{closing?.actorName ? <> by <b>{closing.actorName}</b></> : null} at {clock(closedAt, false)} · {timeAgoWithSuffix(closedAt)} · {span(closedAt - detail.createdAt)} after the request</>
            : <>Updated {timeAgoWithSuffix(detail.updatedAt)}{detail.nextMoveOwnerName ? <> · next move <b>{detail.nextMoveOwnerName}</b></> : null}</>}
        </span>
      </div>

      {detail.lastMeaningfulSummary && <p className="s-wc-outcome">{renderWithMentions(detail.lastMeaningfulSummary)}</p>}
      <div className="s-wc-facts">{facts.map((fact) => <span key={fact}>{fact}</span>)}</div>
      {cue && (
        <p className="s-wc-cue"><b>{cue.eyebrow}</b> {cue.title}. {cue.body}</p>
      )}
      {links}
    </header>
  );
}

/* ── links ───────────────────────────────────────────────────────────────── */

type ScoutLink = { label: string; route: Route };
type MadeLink = { label: string; material: WorkMaterial; display: string };

function scoutLinks(detail: WorkDetail): ScoutLink[] {
  const ask = detail.primaryInvocation;
  const sessionId = ask?.resolvedSessionId ?? ask?.targetSessionId;
  return [
    detail.conversationId ? { label: "Chat", route: { view: "conversation", conversationId: detail.conversationId } } : null,
    sessionId ? { label: "Session", route: { view: "sessions", sessionId } } : null,
    ask?.flightId ? { label: "Flight", route: { view: "sessions", flightId: ask.flightId } } : null,
    ask || detail.conversationId ? { label: "Tail", route: workTailRoute(detail) } : null,
  ].filter(Boolean) as ScoutLink[];
}

const STUDY_PATH = /^design\/studio\/(?:app\/studies\/([^/]+)\/page\.tsx|views\/([^/]+)\.tsx)$/;

/** Documents and studies this work wrote, newest evidence first. */
export function madeLinks(detail: WorkDetail): MadeLink[] {
  const out: MadeLink[] = [];
  for (const material of touchedMaterials(detail)) {
    const study = material.path.match(STUDY_PATH);
    const outside = material.path.startsWith("/") || material.path.startsWith("~");
    if (study) {
      out.push({ label: "Studio study", material, display: `/studies/${study[1] ?? study[2]}` });
    } else if (material.kind === "plan" || material.kind === "spec" || material.kind === "doc") {
      out.push({ label: material.kind === "doc" ? "Doc" : material.kind === "plan" ? "Plan" : "Spec", material, display: material.path });
    } else if (outside && /\.(md|markdown|txt)$/i.test(material.path)) {
      out.push({ label: "Note", material, display: material.path.split("/").slice(-2).join("/") });
    }
  }
  return out.slice(0, 6);
}

export function WorkLinks({
  detail,
  embedded,
  navigate,
  onSelectMaterial,
}: {
  detail: WorkDetail;
  embedded: boolean;
  navigate: Navigate;
  onSelectMaterial: (materialId: string) => void;
}) {
  const { route } = useScout();
  const scout = scoutLinks(detail);
  const made = madeLinks(detail);
  if (scout.length === 0 && made.length === 0) return null;
  const all = () => [
    ...scout.map((link) => `${link.label}: ${absoluteUrl(link.route)}`),
    ...made.map((link) => `${link.label}: ${link.material.path}`),
  ].join("\n");

  return (
    <div className="s-wc-links">
      {scout.length > 0 && (
        <div className="s-wc-link-group">
          <span className="s-wc-label">In Scout</span>
          {scout.map((link) => {
            const path = routePath(link.route);
            return (
              <div key={link.label} className="s-wc-link-row">
                <a
                  href={path}
                  target={embedded ? "_blank" : undefined}
                  rel={embedded ? "noreferrer" : undefined}
                  onClick={(event: MouseEvent) => {
                    if (embedded || event.metaKey || event.ctrlKey || event.shiftKey) return;
                    event.preventDefault();
                    openContent(navigate, link.route, { returnTo: route });
                  }}
                >
                  {link.label}
                </a>
                <code title={path}>{path}</code>
                <CopyMark value={absoluteUrl(link.route)} label={`Copy ${link.label.toLowerCase()} link`} />
              </div>
            );
          })}
        </div>
      )}
      {made.length > 0 && (
        <div className="s-wc-link-group">
          <span className="s-wc-label">Made by this work</span>
          {made.map((link) => (
            <div key={link.material.id} className="s-wc-link-row">
              <button type="button" onClick={() => onSelectMaterial(link.material.id)} title="Show in Files">{link.label}</button>
              <code title={link.material.path}>{link.display}</code>
              <CopyMark value={link.material.path} label="Copy path" />
            </div>
          ))}
        </div>
      )}
      <CopyButton value={all} className="s-wc-ghost s-wc-copy-all">Copy all</CopyButton>
    </div>
  );
}

/* ── request ─────────────────────────────────────────────────────────────── */

export function WorkRequestCard({ detail, onOpenOriginal }: { detail: WorkDetail; onOpenOriginal: () => void }) {
  const ask = detail.primaryInvocation;
  const task = ask?.task?.trim() || initialWorkBriefSummary(detail);
  const outline = useMemo(() => (task ? outlineRequest(task) : null), [task]);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const previewId = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const preview = previewRef.current;
    const content = contentRef.current;
    if (!preview || !content || expanded) return;
    const measure = () => {
      const regions = preview.querySelectorAll<HTMLElement>("[data-request-preview]");
      let clipped = false;
      for (const region of regions) {
        const overflows = region.scrollHeight > region.clientHeight + 1;
        region.dataset.clipped = String(overflows);
        clipped ||= overflows;
      }
      setOverflows(clipped);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded, task]);

  if (!task || !outline) return null;
  const from = ask?.requesterName ?? ask?.requesterId;
  const to = ask?.targetAgentName ?? ask?.targetAgentId ?? detail.ownerName;
  const lists: Array<[string, RequestLine[]]> = [
    ["Build", outline.build],
    ["Guardrails", outline.guard],
    ["Hand back", outline.deliver],
  ];

  return (
    <section className="s-wc-card s-wc-request" data-kind="ask" data-work-id={detail.id} data-invocation-id={ask?.invocationId ?? undefined} data-expanded={expanded} data-clipped={!expanded && overflows}>
      <div className="s-wc-req-top">
        <span className="s-wc-label">Request{from || to ? ` · ${from ?? "?"} → ${to ?? "?"}` : ""}</span>
        <span className="s-wc-spacer" />
        <button type="button" className="s-wc-ghost" onClick={onOpenOriginal}>
          <FileText size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>Original text</span>
        </button>
        <CopyButton value={() => task} className="s-wc-ghost">Copy</CopyButton>
      </div>
      <div id={previewId} ref={previewRef} className="s-wc-req-preview">
        <div ref={contentRef} className="s-wc-req-content">
          <div className="s-wc-req-intro" data-request-preview>
          {outline.context.map((line) => <p key={line} className="s-wc-req-context">{line}</p>)}
          <p className="s-wc-req-ask">{outline.ask}</p>

          {outline.readFirst.length > 0 && (
            <div className="s-wc-req-row">
              <span className="s-wc-label">Read first</span>
              <div className="s-wc-chips">
                {outline.readFirst.map((item) => (
                  <code key={item} className="s-wc-file-chip">
                    <FileText size={11} strokeWidth={1.8} aria-hidden="true" />
                    {item}
                    <CopyMark value={item} />
                  </code>
                ))}
              </div>
            </div>
          )}
          {outline.spec.length > 0 && (
            <div className="s-wc-req-row">
              <span className="s-wc-label">Spec</span>
              <div className="s-wc-chips">
                {outline.spec.map((item) => <span key={item} className="s-wc-spec-chip">{item}</span>)}
              </div>
            </div>
          )}

          </div>

          {lists.some(([, items]) => items.length > 0) && (
            <div className="s-wc-req-cols">
              {lists.filter(([, items]) => items.length > 0).map(([title, items]) => (
                <div key={title} className="s-wc-req-list">
                  <div className="s-wc-req-list-head"><b>{title}</b><span>{items.length}</span></div>
                  <ul data-request-preview>
                    {items.map((line, index) => (
                      <li key={index}>{line.lead && <><b>{line.lead}</b> </>}{line.rest}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {outline.authorized && (
            <p className="s-wc-req-auth">
              <Check size={13} strokeWidth={2} aria-hidden="true" />
              <span>{outline.authorized}</span>
            </p>
          )}
        </div>
      </div>
      {(overflows || expanded) && (
        <div className="s-wc-req-footer">
          <button
            type="button"
            className="s-wc-ghost s-wc-req-toggle"
            aria-expanded={expanded}
            aria-controls={previewId}
            onClick={() => {
              if (expanded) previewRef.current?.closest(".s-wc-request")?.scrollIntoView({ block: "start" });
              setExpanded((value) => !value);
            }}
          >
            <span>{expanded ? "Show less" : "Show more"}</span>
            <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

/* ── run ─────────────────────────────────────────────────────────────────── */

function askSourceLabel(source: string | null | undefined): string {
  const normalized = source?.toLowerCase() ?? "";
  if (normalized.includes("mcp")) return "Scout MCP";
  if (normalized.includes("cli")) return "Scout CLI";
  return source || "Scout";
}

function Fact({ k, v, copy }: { k: string; v: string; copy?: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={copy ? "s-wc-mono" : undefined} title={copy}>
        {v}
        {copy && <CopyMark value={copy} label={`Copy ${k.toLowerCase()}`} />}
      </dd>
    </div>
  );
}

export function WorkRunCard({
  detail,
  navigate,
  lifecycleNote,
  statusText,
  idsText,
}: {
  detail: WorkDetail;
  navigate: Navigate;
  lifecycleNote: string | null;
  statusText: string;
  idsText: string;
}) {
  const { route } = useScout();
  const openMenu = useContextMenu();
  const ask = detail.primaryInvocation;
  if (!ask) return null;
  const observed = observedRuntime(detail);
  const model = ask.observedModel ?? observed.model ?? ask.resolvedModel ?? ask.requestedModel;
  const effort = ask.observedReasoningEffort ?? observed.effort ?? ask.resolvedReasoningEffort ?? ask.requestedReasoningEffort;
  const harness = ask.observedHarness ?? ask.resolvedHarness ?? ask.requestedHarness;
  const sessionId = ask.resolvedSessionId ?? ask.targetSessionId;
  const unreported = [model ? null : "Model", effort ? null : "effort"].filter(Boolean);
  const startedApart = ask.startedAt !== null && ask.startedAt - ask.createdAt > 2000;
  const endAt = ask.completedAt;
  const endLabel = ask.state === "failed" ? "Failed" : ask.state === "cancelled" ? "Cancelled" : "Completed";
  const observeRoute: Route | null = sessionId
    ? { view: "sessions", sessionId, ...(ask.targetAgentId ? { agentId: ask.targetAgentId } : {}) }
    : ask.targetAgentId
    ? { view: "agents-v2", agentId: ask.targetAgentId, tab: "observe" }
    : null;

  return (
    <section className="s-wc-card" data-flight-id={ask.flightId ?? undefined} data-agent-id={ask.targetAgentId ?? undefined}>
      <div className="s-wc-card-head">
        <h2>Run</h2>
        <span className="s-wc-sub">
          {ask.action} from {askSourceLabel(ask.source)}
          {ask.requesterName || ask.targetAgentName ? ` · ${ask.requesterName ?? ask.requesterId ?? "?"} → ${ask.targetAgentName ?? ask.targetAgentId ?? "?"}` : ""}
        </span>
      </div>

      <div className="s-wc-life">
        <Step label={ask.startedAt === null || startedApart ? "Created" : "Created and started"} at={ask.createdAt} />
        {startedApart && ask.startedAt !== null && (
          <>
            <span className="s-wc-life-line"><em>{span(ask.startedAt - ask.createdAt)}</em></span>
            <Step label="Started" at={ask.startedAt} />
          </>
        )}
        <span className="s-wc-life-line" data-open={endAt === null || undefined}>
          <em>{span((endAt ?? Date.now()) - (ask.startedAt ?? ask.createdAt))}</em>
        </span>
        {endAt !== null
          ? <Step label={endLabel} at={endAt} on />
          : <span className="s-wc-step" data-now><i /><b>{(ask.state ?? "running").replace(/^./, (c) => c.toUpperCase())}</b><time>now</time></span>}
      </div>
      {lifecycleNote && <p className="s-wc-note">{lifecycleNote}</p>}

      <dl className="s-wc-facts-grid">
        {harness && <Fact k="Harness" v={harness} />}
        {model && <Fact k="Model" v={model} />}
        {effort && <Fact k="Effort" v={effort} />}
        {ask.resolvedTransport && <Fact k="Transport" v={ask.resolvedTransport} />}
        {sessionId && <Fact k="Session" v={shortId(sessionId)} copy={sessionId} />}
        {ask.flightId && <Fact k="Flight" v={shortId(ask.flightId)} copy={ask.flightId} />}
        <Fact k="Invocation" v={shortId(ask.invocationId)} copy={ask.invocationId} />
        {detail.conversationId && <Fact k="Conversation" v={shortId(detail.conversationId)} copy={detail.conversationId} />}
      </dl>
      {unreported.length > 0 && (
        <p className="s-wc-note">
          {unreported.length === 2 ? "Model and effort were" : `${unreported[0] === "Model" ? "Model was" : "Effort was"}`} not reported back by the harness.
        </p>
      )}

      <div className="s-wc-actions">
        {observeRoute && (
          <button type="button" className="s-wc-btn s-wc-btn-primary" onClick={() => openContent(navigate, observeRoute, { returnTo: route })}>
            <Radio size={12} strokeWidth={1.8} aria-hidden="true" />
            <span>{sessionId ? "Observe session" : "Observe agent"}</span>
          </button>
        )}
        {detail.conversationId && (
          <button type="button" className="s-wc-btn" onClick={() => openContent(navigate, { view: "conversation", conversationId: detail.conversationId! }, { returnTo: route })}>
            <MessageSquare size={12} strokeWidth={1.8} aria-hidden="true" />
            <span>Open chat</span>
          </button>
        )}
        <SessionHopMenu
          className="s-wc-btn"
          label="Terminal"
          hints={{ agentId: ask.targetAgentId, sessionRefs: [ask.resolvedSessionId, ask.targetSessionId] }}
          navigate={navigate}
          returnTo={route}
        />
        <button type="button" className="s-wc-btn" onClick={() => openContent(navigate, workTailRoute(detail), { returnTo: route })}>
          <Activity size={12} strokeWidth={1.8} aria-hidden="true" />
          <span>Tail</span>
        </button>
        <span className="s-wc-spacer" />
        <button
          type="button"
          className="s-wc-btn s-wc-more"
          aria-label="More run actions"
          title="Copy status · Copy MCP ids"
          onClick={(event) => openMenu(event, [
            { kind: "action", label: "Copy status", onSelect: () => copyText(statusText) },
            { kind: "action", label: "Copy MCP ids", onSelect: () => copyText(idsText) },
          ])}
        >
          <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function Step({ label, at, on }: { label: string; at: number; on?: boolean }) {
  return (
    <span className="s-wc-step" data-on={on || undefined}>
      <i />
      <b>{label}</b>
      <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{clock(at)}</time>
    </span>
  );
}

/* ── files ───────────────────────────────────────────────────────────────── */

type Scope = "touched" | "read" | "all";

type Group = { root: string; label: string; files: WorkMaterial[] };

const NESTED_ROOTS = new Set(["apps", "packages", "design", "crates", "services", "libs"]);

export function materialArea(material: WorkMaterial): { root: string; label: string } {
  const path = material.path;
  if (path.startsWith("/") || path.startsWith("~")) {
    return { root: path.slice(0, path.lastIndexOf("/") + 1), label: "Outside the repo" };
  }
  const parts = path.split("/");
  if (parts.length === 1) return { root: "", label: "Repo root" };
  const depth = NESTED_ROOTS.has(parts[0]!) && parts.length > 2 ? 2 : 1;
  const root = parts.slice(0, depth).join("/");
  return { root: `${root}/`, label: root };
}

function diffOf(material: WorkMaterial) {
  return material.diffStat ? workMaterialDiffTotal(material.diffStat) : null;
}

function groupMaterials(materials: WorkMaterial[]): Group[] {
  const groups = new Map<string, Group>();
  for (const material of materials) {
    const area = materialArea(material);
    const group = groups.get(area.root) ?? { ...area, files: [] };
    group.files.push(material);
    groups.set(area.root, group);
  }
  for (const group of groups.values()) group.files.sort((a, b) => a.path.localeCompare(b.path));
  return [...groups.values()].sort((a, b) =>
    (a.label === "Outside the repo" ? 1 : 0) - (b.label === "Outside the repo" ? 1 : 0)
    || b.files.length - a.files.length
    || a.label.localeCompare(b.label));
}

function splitPath(path: string, root = ""): [string, string] {
  const rel = root && path.startsWith(root) ? path.slice(root.length) : path;
  const cut = rel.lastIndexOf("/") + 1;
  return [rel.slice(0, cut), rel.slice(cut)];
}

function DiffBar({ add, del, max }: { add: number; del: number; max: number }) {
  const w = 48;
  const a = add ? Math.max(2, Math.round((add / max) * w)) : 0;
  const d = del ? Math.max(2, Math.round((del / max) * w)) : 0;
  return (
    <span className="s-wc-bar" style={{ width: w }} aria-hidden="true">
      {a > 0 && <i style={{ width: a }} />}
      {d > 0 && <s style={{ width: d }} />}
    </span>
  );
}

function DiffStat({ add, del }: { add: number; del: number }) {
  return <span className="s-wc-stat">+{add}{del > 0 && <i> −{del}</i>}</span>;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const PREVIEW_LINE_CAP = 4000;

export function WorkFileBrowser({
  detail,
  selectedId,
  onSelect,
  content,
  loading,
  error,
  onOpen,
}: {
  detail: WorkDetail;
  selectedId: string | null;
  onSelect: (materialId: string) => void;
  content: WorkMaterialContent | null;
  loading: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  const inventory = detail.inventory;
  const materials = useMemo(() => (inventory?.materials ?? []).filter((m) => m.status !== "deleted"), [inventory]);
  const touched = useMemo(() => materials.filter((m) => m.status !== "observed"), [materials]);
  const read = useMemo(() => materials.filter((m) => m.status === "observed"), [materials]);
  const [scope, setScope] = useState<Scope>(touched.length > 0 ? "touched" : "all");
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const scoped = scope === "touched" ? touched : scope === "read" ? read : materials;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? scoped.filter((m) => m.path.toLowerCase().includes(q)) : scoped;
  }, [scoped, query]);
  const groups = useMemo(() => groupMaterials(visible), [visible]);
  const ordered = useMemo(() => groups.flatMap((g) => g.files), [groups]);
  const maxLines = useMemo(() => Math.max(1, ...visible.map((m) => { const d = diffOf(m); return d ? d.additions + d.deletions : 0; })), [visible]);
  const selected = materials.find((m) => m.id === selectedId) ?? null;

  // Keep a file previewed: the first visible one until the reader picks.
  useEffect(() => {
    if (ordered.length > 0 && (!selectedId || !materials.some((m) => m.id === selectedId))) onSelect(ordered[0]!.id);
  }, [ordered, selectedId, materials, onSelect]);

  // A pick from outside (a "Made by this work" link) brings its row into view.
  useEffect(() => {
    if (!selectedId) return;
    if (!visible.some((m) => m.id === selectedId)) {
      setQuery("");
      if (!scoped.some((m) => m.id === selectedId)) setScope("all");
    }
    // Scroll the list only; scrollIntoView would also move the page.
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-material-id="${CSS.escape(selectedId)}"]`);
    if (list && row) {
      const head = 30;
      const top = row.offsetTop;
      if (top - head < list.scrollTop) list.scrollTop = top - head;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const step = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = ordered.findIndex((m) => m.id === selectedId);
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) onSelect(next.id);
  };

  if (!inventory) return null;
  const selDiff = selected ? diffOf(selected) : null;
  const imageUrl = workMaterialImageUrl(detail.id, selected);
  const lines = content ? content.content.split("\n") : [];
  const [selDir, selName] = selected ? splitPath(selected.path) : ["", ""];
  const segments: Array<[Scope, string, number]> = [
    ["touched", "Touched", touched.length],
    ["read", "Read", read.length],
    ["all", "All", materials.length],
  ];

  return (
    <section className="s-wc-card s-work-materials-section">
      <div className="s-wc-card-head">
        <h2>Files</h2>
        <span className="s-wc-sub">{inventory.limitations[0] ?? `${inventory.source} evidence · ${inventory.confidence} confidence`}</span>
      </div>
      {materials.length === 0 ? (
        <p className="s-wc-note">No files recorded for this work yet.</p>
      ) : (
        <>
          <div className="s-wc-file-bar">
            <span className="s-wc-seg" role="tablist" aria-label="Which files">
              {segments.map(([key, label, count]) => (
                <button key={key} type="button" role="tab" aria-selected={scope === key} disabled={count === 0} onClick={() => setScope(key)}>
                  {label} <span>{count}</span>
                </button>
              ))}
            </span>
            <label className="s-wc-filter">
              <Search size={12} strokeWidth={1.8} aria-hidden="true" />
              <input
                ref={filterRef}
                value={query}
                placeholder="Filter files"
                aria-label="Filter files"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setQuery(""); filterRef.current?.blur(); }
                  else step(event);
                }}
              />
              {query ? <span className="s-wc-sub">{visible.length}</span> : <kbd>/</kbd>}
            </label>
          </div>
          <div className="s-wc-browser">
            <div ref={listRef} className="s-wc-file-list" role="listbox" aria-label="Files" tabIndex={0} onKeyDown={step}>
              {groups.length === 0 && <p className="s-wc-note s-wc-list-empty">No files match “{query}”.</p>}
              {groups.map((group) => {
                const add = group.files.reduce((s, f) => s + (diffOf(f)?.additions ?? 0), 0);
                const del = group.files.reduce((s, f) => s + (diffOf(f)?.deletions ?? 0), 0);
                return (
                  <div key={group.root} role="group" aria-label={group.label}>
                    <div className="s-wc-list-head">
                      <b>{group.label}</b>
                      {group.label === "Outside the repo" && <code title={group.root}>{group.root.split("/").slice(-3).join("/")}</code>}
                      <span className="s-wc-spacer" />
                      {add + del > 0 && <DiffStat add={add} del={del} />}
                      <span className="s-wc-count">{group.files.length}</span>
                    </div>
                    {group.files.map((file) => {
                      const [dir, name] = splitPath(file.path, group.root);
                      const diff = diffOf(file);
                      return (
                        <div
                          key={file.id}
                          role="option"
                          aria-selected={file.id === selectedId}
                          data-material-id={file.id}
                          className="s-wc-file-row"
                          title={file.path}
                          onClick={() => onSelect(file.id)}
                        >
                          <code><span>{dir}</span>{name}</code>
                          <span className="s-wc-row-copy"><CopyMark value={file.path} label="Copy path" /></span>
                          <span className="s-wc-spacer" />
                          {(file.status === "untracked" || file.status === "added") && <span className="s-wc-new">new</span>}
                          {diff && <><DiffStat add={diff.additions} del={diff.deletions} /><DiffBar add={diff.additions} del={diff.deletions} max={maxLines} /></>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="s-wc-preview">
              {selected ? (
                <>
                  <div className="s-wc-preview-head">
                    <code title={selected.path}><span>{selDir}</span>{selName}</code>
                    <CopyMark value={selected.path} label="Copy path" />
                    <span className="s-wc-spacer" />
                    {selDiff && <DiffStat add={selDiff.additions} del={selDiff.deletions} />}
                    {content && <span className="s-wc-sub">{formatBytes(content.sizeBytes)} · {lines.length} lines</span>}
                  </div>
                  <div className="s-wc-preview-tabs">
                    <b>File</b>
                    {content?.truncated && <span>Preview truncated</span>}
                    <span className="s-wc-spacer" />
                    {imageUrl ? (
                      <a className="s-wc-ghost" href={imageUrl} target="_blank" rel="noreferrer">Open <ExternalLink size={11} strokeWidth={1.8} aria-hidden="true" /></a>
                    ) : (
                      <button type="button" className="s-wc-ghost" onClick={onOpen} disabled={!content}>
                        Open <ExternalLink size={11} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {imageUrl ? (
                    <div className="s-wc-image-preview"><img src={imageUrl} alt={selected.path} /></div>
                  ) : loading ? (
                    <p className="s-wc-note s-wc-preview-state">Loading file…</p>
                  ) : error ? (
                    <p className="s-wc-note s-wc-preview-state">{error}</p>
                  ) : content ? (
                    <pre className="s-wc-code">
                      {lines.slice(0, PREVIEW_LINE_CAP).map((line, index) => (
                        <div key={index}><i>{index + 1}</i>{line || " "}</div>
                      ))}
                      {lines.length > PREVIEW_LINE_CAP && <div><i>…</i>{lines.length - PREVIEW_LINE_CAP} more lines — Open to read all</div>}
                    </pre>
                  ) : null}
                </>
              ) : (
                <p className="s-wc-note s-wc-preview-state">Pick a file to preview it.</p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
