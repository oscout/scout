import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import "./agents-feed-detail.css";
import { Activity, AppWindow, ExternalLink, FileText, FolderCode, MessageSquare, SquareTerminal, X } from "lucide-react";
import { api } from "../../lib/api.ts";
import { timeAgo } from "../../lib/time.ts";
import {
  peekTerminalSessionInventory,
  resolveSessionTerminalTarget,
  subscribeTerminalSessionInventory,
  terminalHopRoute,
  warmTerminalSessionInventory,
} from "../../lib/session-terminal-hop.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { sessionHopMenuItems } from "../../components/SessionHopMenu.tsx";
import { HarnessMark, harnessLabel } from "../../components/HarnessMark.tsx";
import { MessageEmbeds } from "../../components/MessageEmbeds.tsx";
import type { Agent, AgentObservePayload, Message, Route } from "../../lib/types.ts";
import { formatSessionRouteRef } from "../../../shared/session-route-ref.ts";
import { agentLookup, type HomeAgentDay } from "./agents-home-feed-model.ts";
import { displayPath, resolveUpdatePath, toArticle, toSessionUpdate, type SessionUpdate } from "./agents-feed-article.ts";

/* ──────────────────────────────────────────────────────────────────────────
   Agents feed detail — a feed post opened as a short article, floating OVER
   the feed (the feed never reflows) on a wide pane, rising as a sheet on a
   narrow one. Ported from the studio study
   design/studio/app/studies/agents-feed-detail.

   Reads the post's conversation (/api/messages): the agent's newest message
   is the article, the message before it from someone else is the ask it
   answered, the agent's other messages there are "Earlier". A post worked
   outside Scout reads its harness session's trace (/api/session-ref)
   instead: the same article, plus the steps behind it and the files the
   session changed, so every row opens here rather than some jumping away. Quick links
   along the top only render when they resolve to something real: the
   thread, the Scout app (scout://conversation/…), the agent's terminal
   (terminal inventory), its workspace in Code, previews the update names.
   ────────────────────────────────────────────────────────────────────────── */

const MESSAGE_LIMIT = 40;
const PANE_MIN = 380;
const FEED_MIN = 320;
const WIDTH_KEY = "scout.agents.home.detailWidth";

type Loaded = { latest: Message | null; ask: Message | null; earlier: Message[] };

function isByAgent(message: Message, row: HomeAgentDay): boolean {
  if (row.agentId && message.actorId) return message.actorId === row.agentId;
  return message.actorName === row.agent;
}

function useUpdate(row: HomeAgentDay): { data: Loaded | null; failed: boolean } {
  const [state, setState] = useState<{ id: string; data: Loaded | null; failed: boolean }>({ id: row.id, data: null, failed: false });
  useEffect(() => {
    if (!row.conversationId) return;
    let live = true;
    api<Message[]>(`/api/messages?conversationId=${encodeURIComponent(row.conversationId)}&limit=${MESSAGE_LIMIT}`)
      .then((messages) => {
        if (!live) return;
        const ordered = [...messages].sort((a, b) => b.createdAt - a.createdAt);
        const mine = ordered.filter((m) => isByAgent(m, row));
        const latest = mine[0] ?? null;
        const ask = latest
          ? ordered.find((m) => m.createdAt < latest.createdAt && !isByAgent(m, row) && m.id === latest.replyToMessageId)
            ?? ordered.find((m) => m.createdAt < latest.createdAt && !isByAgent(m, row))
            ?? null
          : null;
        setState({ id: row.id, data: { latest, ask, earlier: mine.slice(1, 6) }, failed: false });
      })
      .catch(() => live && setState({ id: row.id, data: null, failed: true }));
    return () => {
      live = false;
    };
  }, [row]);
  return state.id === row.id ? { data: state.data, failed: state.failed } : { data: null, failed: false };
}

type SessionLoaded = { update: SessionUpdate | null; cwd: string | null; model: string | null };

function useSessionUpdate(row: HomeAgentDay): { data: SessionLoaded | null; failed: boolean } {
  const ref = !row.conversationId && row.sessionId ? formatSessionRouteRef(row.harness, row.sessionId) ?? row.sessionId : null;
  const [state, setState] = useState<{ id: string; data: SessionLoaded | null; failed: boolean }>({ id: row.id, data: null, failed: false });
  useEffect(() => {
    if (!ref) return;
    let live = true;
    api<{ observe?: AgentObservePayload | null }>(`/api/session-ref/${encodeURIComponent(ref)}`)
      .then((payload) => {
        if (!live) return;
        const data = payload.observe?.data ?? null;
        setState({
          id: row.id,
          data: {
            update: toSessionUpdate(data, row.ts),
            cwd: data?.metadata?.session?.cwd ?? null,
            model: data?.metadata?.session?.model ?? null,
          },
          failed: false,
        });
      })
      .catch(() => live && setState({ id: row.id, data: null, failed: true }));
    return () => {
      live = false;
    };
  }, [ref, row.id, row.ts]);
  return state.id === row.id ? { data: state.data, failed: state.failed } : { data: null, failed: false };
}

/* Re-render when the terminal inventory lands, so the Terminal jump shows up
   on first open instead of only on the next one. */
function useTerminalInventoryTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const off = subscribeTerminalSessionInventory(() => setTick((n) => n + 1));
    warmTerminalSessionInventory();
    return off;
  }, []);
  return tick;
}

const LINK_LIMIT = 4;

const HOP_LABELS: Record<string, string> = {
  "Open in Scout app": "Scout terminal",
  "Focus pane in Herdr": "Herdr pane",
  "Open in terminal app": "Terminal app",
};

/* Name each link by its host, and by host plus last path segment when two
   share a host ("github.com · 14901"), so a row of links is not four
   identical "Preview" chips. */
function linkLabels(urls: string[]): Array<{ url: string; label: string }> {
  const parsed = urls.flatMap((url) => {
    try {
      const { hostname, pathname } = new URL(url);
      return [{ url, host: hostname.replace(/^www\./, ""), last: pathname.split("/").filter(Boolean).pop() ?? null }];
    } catch {
      return [];
    }
  });
  const perHost = new Map<string, number>();
  for (const link of parsed) perHost.set(link.host, (perHost.get(link.host) ?? 0) + 1);
  return parsed.map((link) => ({
    url: link.url,
    label: perHost.get(link.host)! > 1 && link.last ? `${link.host} · ${link.last}` : link.host,
  }));
}

type QuickLink = { id: string; label: string; title: string; icon: ReactNode; primary?: boolean } & (
  | { route: Route }
  | { onSelect: () => void }
  | { href: string; external?: boolean }
);

function readWidth(): number | null {
  try {
    const value = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/* Drag the left edge to resize; arrow keys nudge it; double-click resets. */
function useResizable(stage: HTMLElement | null) {
  const [width, setWidth] = useState<number | null>(readWidth);
  const clamp = (w: number) => {
    const max = (stage?.clientWidth ?? 1200) - FEED_MIN;
    return Math.round(Math.max(PANE_MIN, Math.min(max, w)));
  };
  const commit = (w: number | null) => {
    setWidth(w);
    try {
      if (w == null) window.localStorage.removeItem(WIDTH_KEY);
      else window.localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* storage unavailable — width resets next visit */
    }
  };
  const current = () => width ?? Math.round((stage?.clientWidth ?? 1200) * 0.4);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = current();
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = "true";
    let next = startW;
    const move = (ev: PointerEvent) => {
      next = clamp(startW + (startX - ev.clientX));
      setWidth(next);
    };
    const up = () => {
      delete handle.dataset.dragging;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      commit(next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") commit(clamp(current() + 24));
    if (e.key === "ArrowRight") commit(clamp(current() - 24));
  };
  return { width, onPointerDown, onKeyDown, reset: () => commit(null) };
}

export function AgentsFeedDetail({
  row,
  agents,
  navigate,
  onClose,
  stage,
  inApp = false,
}: {
  row: HomeAgentDay;
  agents: Agent[];
  navigate: (route: Route) => void;
  onClose: () => void;
  /** The positioned stage the panel floats in — bounds the resize. */
  stage: HTMLElement | null;
  /** Inside the Scout app: no "Open in Scout" jump. */
  inApp?: boolean;
}) {
  const { data, failed } = useUpdate(row);
  const readsSession = !row.conversationId && Boolean(row.sessionId);
  const session = useSessionUpdate(row);
  const inventoryTick = useTerminalInventoryTick();
  const [askOpen, setAskOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const resize = useResizable(stage);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setAskOpen(false);
    setNotesOpen(false);
    panelRef.current?.querySelector(".afd-scroll")?.scrollTo({ top: 0 });
  }, [row.id]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const agent = useMemo(() => agentLookup(agents)(row.agentId, row.agent), [agents, row.agent, row.agentId]);
  const reviewers = row.reviewers && row.reviewers.length > 1 ? row.reviewers : null;
  const harness = reviewers ? null : row.harness ?? agent?.harness ?? null;
  const root = row.root ?? session.data?.cwd ?? agent?.projectRoot ?? agent?.cwd ?? null;
  const update = session.data?.update ?? null;
  const latestText = readsSession ? update?.text ?? null : data?.latest?.body ?? null;
  const article = useMemo(() => (latestText ? toArticle(latestText) : null), [latestText]);
  const loading = readsSession ? !session.data && !session.failed : Boolean(row.conversationId) && !data && !failed;
  const earlier = readsSession
    ? update?.earlier ?? []
    : (data?.earlier ?? []).map((message) => ({ id: message.id, text: message.body, at: message.createdAt as number | null }));

  const links = useMemo<QuickLink[]>(() => {
    const out: QuickLink[] = [];
    if (row.route && readsSession) {
      out.push({ id: "trace", label: "Trace", title: "Open the full session trace", icon: <Activity size={13} strokeWidth={1.8} />, primary: true, route: row.route });
    } else if (row.route) {
      out.push({ id: "thread", label: "Thread", title: "Open the conversation", icon: <MessageSquare size={13} strokeWidth={1.8} />, primary: true, route: row.route });
    }
    if (row.conversationId && !inApp) {
      const href = `scout://conversation/${encodeURIComponent(row.conversationId)}`;
      out.push({ id: "app", label: "Open in Scout", title: href, icon: <AppWindow size={13} strokeWidth={1.8} />, href });
    }
    const sessions = peekTerminalSessionInventory();
    const target = sessions && (row.agentId || row.sessionId)
      ? resolveSessionTerminalTarget(sessions, { agentId: row.agentId, sessionRefs: [row.sessionId] })
      : null;
    const terminal = target ? terminalHopRoute(target, row.agentId) : null;
    if (terminal) {
      out.push({ id: "terminal", label: "Terminal", title: `Open ${target?.surface.sessionName ?? "the agent's terminal"}`, icon: <SquareTerminal size={13} strokeWidth={1.8} />, route: terminal });
    }
    // The same hops the trace's Terminal menu offers for a live surface:
    // the app's native tile, a Herdr pane, the local terminal app.
    for (const item of target ? sessionHopMenuItems({ target, agentId: row.agentId, navigate, includeWeb: false, emptyFallback: false }) : []) {
      if (item.kind !== "action") continue;
      const label = HOP_LABELS[item.label] ?? item.label;
      out.push({ id: `hop:${item.label}`, label, title: item.label, icon: <SquareTerminal size={13} strokeWidth={1.8} />, onSelect: item.onSelect });
    }
    if (root) {
      const leaf = root.replace(/\/+$/, "").split("/").pop();
      const label = leaf && row.projects[0] && leaf !== row.projects[0] ? `Code · ${leaf}` : "Code";
      out.push({ id: "code", label, title: displayPath(root), icon: <FolderCode size={13} strokeWidth={1.8} />, route: { view: "code", root } });
    }
    for (const link of linkLabels(article?.links ?? []).slice(0, LINK_LIMIT)) {
      out.push({ id: link.url, label: link.label, title: link.url, icon: <ExternalLink size={13} strokeWidth={1.8} />, href: link.url, external: true });
    }
    return out;
    // inventoryTick: recompute once the terminal inventory arrives.
  }, [article?.links, inApp, inventoryTick, navigate, readsSession, root, row.agentId, row.conversationId, row.projects, row.route, row.sessionId]);

  const fileRoute = (path: string): Route | null => {
    const file = resolveUpdatePath(path, root);
    return file ? { view: "code", root: root ?? file.slice(0, file.lastIndexOf("/")), file } : null;
  };

  const meta = [
    harness ? harnessLabel(harness) : null,
    agent?.model ?? session.data?.model ?? null,
    row.projects[0] ? `/${row.projects[0]}` : null,
    timeAgo(row.ts),
    ...(update?.facts ?? []),
  ].filter((part): part is string => Boolean(part));

  return (
    <aside
      ref={panelRef}
      className="afd-panel"
      aria-label={`${row.name} update`}
      style={resize.width ? ({ "--afd-width": `${resize.width}px` } as CSSProperties) : undefined}
    >
      <div
        className="afd-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize detail"
        tabIndex={0}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onDoubleClick={resize.reset}
      />
      <span className="afd-grabber" aria-hidden="true" />
      <header className="afd-head">
        <div className="afd-byline">
          <span className="ahf-avatar afd-avatar">
            {reviewers ? (
              <span className="ahf-pile">
                {reviewers.slice(0, 2).map((r) => (
                  <AgentAvatar key={r.agent} name={r.agent} harness={r.harness ?? undefined} size={34} presence={false} scaleWithPreference={false} />
                ))}
              </span>
            ) : (
              <AgentAvatar name={row.agent} harness={harness ?? undefined} size={48} presence={false} scaleWithPreference={false} />
            )}
            <span className="ahf-badge">
              <HarnessMark harness={harness ?? "unknown"} size={15} />
            </span>
          </span>
          <div className="afd-who">
            <div className="afd-name">{reviewers ? `${reviewers.length} reviewers` : row.name}</div>
            <div className="afd-meta">{meta.map((part) => <span key={part}>{part}</span>)}</div>
          </div>
          <button type="button" className="afd-close" onClick={onClose} aria-label="Close detail" title="Close (Esc)">
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        {links.length ? (
          <nav className="afd-links" aria-label="Jump to">
            {links.map((link) =>
              "onSelect" in link ? (
                <button key={link.id} type="button" className="afd-link" title={link.title} onClick={link.onSelect}>
                  {link.icon}
                  <span>{link.label}</span>
                </button>
              ) : "route" in link ? (
                <button
                  key={link.id}
                  type="button"
                  className="afd-link"
                  data-primary={link.primary || undefined}
                  title={link.title}
                  onClick={() => navigate(link.route)}
                >
                  {link.icon}
                  <span>{link.label}</span>
                </button>
              ) : (
                <a
                  key={link.id}
                  className="afd-link"
                  href={link.href}
                  title={link.title}
                  {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {link.icon}
                  <span>{link.label}</span>
                </a>
              ),
            )}
          </nav>
        ) : null}
      </header>

      <div className="afd-scroll">
        <div className="afd-article">
          {!row.conversationId && !row.sessionId ? (
            <>
              <h3 className="afd-headline">{row.headline}</h3>
              <p className="afd-quiet">This update has no conversation or session to read from.</p>
            </>
          ) : loading ? (
            <div className="afd-loading" role="status" aria-label="Loading">
              <span /><span /><span />
            </div>
          ) : !article ? (
            <>
              <h3 className="afd-headline">{row.headline}</h3>
              <p className="afd-quiet">
                {readsSession
                  ? session.failed ? "Couldn't load the session trace." : "The session trace has no message from the agent yet."
                  : failed ? "Couldn't load the conversation." : "The message behind this post is no longer in its conversation."}
              </p>
            </>
          ) : (
            <>
              {data?.ask && !readsSession ? (
                <div className="afd-context" data-open={askOpen || undefined}>
                  <span className="afd-contextBy">Answering {data.ask.actorName}</span>
                  <p className="afd-contextText">{data.ask.body.replace(/\[ask:[^\]]+\]\s*/g, "")}</p>
                  <button type="button" className="afd-more" onClick={() => setAskOpen((open) => !open)}>
                    {askOpen ? "Show less" : "Read the ask"}
                  </button>
                </div>
              ) : null}

              <h3 className="afd-headline">{article.headline || row.headline}</h3>

              {article.body.map((block, i) => {
                if (block.kind === "heading") return <h4 key={i} className="afd-subhead">{block.text.toLowerCase()}</h4>;
                if (block.kind === "para") return <p key={i} className="afd-para">{block.text}</p>;
                if (block.kind === "file") return <FileRow key={i} path={block.path} note={block.note} route={fileRoute(block.path)} navigate={navigate} />;
                return (
                  <a key={i} className="afd-fileRow" href={block.url} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} strokeWidth={1.8} className="afd-fileIcon" />
                    <span className="afd-linkUrl">{block.url.replace(/^https?:\/\//, "")}</span>
                    {block.note ? <span className="afd-fileNote">{block.note}</span> : null}
                  </a>
                );
              })}

              {!readsSession && data?.latest?.attachments?.length ? (
                <div className="afd-embeds">
                  <MessageEmbeds message={data.latest} />
                </div>
              ) : null}

              {article.files.length ? (
                <div className="afd-box">
                  <div className="afd-boxHead">In this update</div>
                  {article.files.map((path) => (
                    <FileRow key={path} path={path} route={fileRoute(path)} navigate={navigate} />
                  ))}
                </div>
              ) : null}

              {article.notes.length ? (
                <div className="afd-notes">
                  <button type="button" className="afd-more" onClick={() => setNotesOpen((open) => !open)}>
                    {notesOpen ? "Hide" : "Show"} working notes <i>·</i> {article.notes.length}
                  </button>
                  {notesOpen ? article.notes.map((note, i) => <p key={i} className="afd-note">{note}</p>) : null}
                </div>
              ) : null}

              {update ? <SessionTrail update={update} traceRoute={row.route} fileRoute={fileRoute} navigate={navigate} /> : null}
            </>
          )}
        </div>

        {earlier.length ? (
          <section className="afd-earlierList" aria-label="Earlier">
            <div className="afd-boxHead">Earlier from {row.name}</div>
            {earlier.map((message) => (
              <div key={message.id} className="afd-earlier">
                <span>{toArticle(message.text).headline || message.text.slice(0, 120)}</span>
                {message.at != null ? <time dateTime={new Date(message.at).toISOString()}>{timeAgo(message.at)}</time> : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

const CHANGED_LIMIT = 8;

/* What the trace adds to a session update: the steps that produced it and
   the files the session changed. The full trace stays one click away. */
function SessionTrail({
  update,
  traceRoute,
  fileRoute,
  navigate,
}: {
  update: SessionUpdate;
  traceRoute: Route | null;
  fileRoute: (path: string) => Route | null;
  navigate: (route: Route) => void;
}) {
  const hidden = update.stepCount - update.steps.length;
  const moreChanged = update.changed.length - CHANGED_LIMIT;
  return (
    <>
      {update.steps.length ? (
        <div className="afd-box">
          <div className="afd-boxHead">Steps behind this update <i>·</i> {update.stepCount}</div>
          {hidden > 0 && traceRoute ? (
            <button type="button" className="afd-more afd-stepsMore" onClick={() => navigate(traceRoute)}>
              {hidden} earlier {hidden === 1 ? "step" : "steps"} in the trace
            </button>
          ) : null}
          {update.steps.map((step) => (
            <div key={step.id} className="afd-step" title={step.arg ?? undefined}>
              <span className="afd-stepTool">{step.tool}</span>
              {step.arg ? <span className="afd-stepArg">{step.arg}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {update.changed.length || update.readCount ? (
        <div className="afd-box">
          <div className="afd-boxHead">Changed in this session</div>
          {update.changed.slice(0, CHANGED_LIMIT).map((path) => (
            <FileRow key={path} path={path} route={fileRoute(path)} navigate={navigate} />
          ))}
          <p className="afd-boxFoot">
            {[
              moreChanged > 0 ? `${moreChanged} more changed` : null,
              update.changed.length ? null : "No files changed",
              update.readCount ? `${update.readCount} read` : null,
            ].filter(Boolean).join(" · ")}
          </p>
        </div>
      ) : null}
    </>
  );
}

function FileRow({
  path,
  note,
  route,
  navigate,
}: {
  path: string;
  note?: string | null;
  route: Route | null;
  navigate: (route: Route) => void;
}) {
  const parts = displayPath(path).split("/");
  const name = parts.pop();
  const content = (
    <>
      <FileText size={13} strokeWidth={1.8} className="afd-fileIcon" />
      <span className="afd-fileName">{name}</span>
      <span className="afd-fileDir">{parts.join("/")}</span>
      {note ? <span className="afd-fileNote">{note}</span> : null}
    </>
  );
  return route ? (
    <button type="button" className="afd-fileRow" title="Open in Code" onClick={() => navigate(route)}>
      {content}
    </button>
  ) : (
    <div className="afd-fileRow" data-static>{content}</div>
  );
}
