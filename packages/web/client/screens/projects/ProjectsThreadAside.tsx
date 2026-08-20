import { ArrowUpRight } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { timeAgo } from "../../lib/time.ts";
import type { Route } from "../../lib/types.ts";
import { shortHomePath } from "./project-overview-helpers.ts";
import { useProjectsInbox } from "./useProjectsInbox.ts";
import {
  sessionOpenRoute,
  threadObserveRoute,
  threadOpenRoute,
  type InboxSession,
  type InboxThread,
} from "./projects-inbox-model.ts";
import "./projects-inbox.css";

type Navigate = (route: Route) => void;
type AsideSelection =
  | { kind: "thread"; thread: InboxThread }
  | { kind: "session"; session: InboxSession };

function findSelection(
  threads: InboxThread[],
  sessions: InboxSession[],
  route: Extract<Route, { view: "agents-v2" }>,
): AsideSelection | null {
  if (route.sessionId) {
    const session = sessions.find((entry) =>
      entry.sessionId === route.sessionId ||
      entry.conversationId === route.sessionId ||
      entry.id === route.sessionId
    );
    if (session) return { kind: "session", session };
    const thread = threads.find((entry) => entry.kind === "native" && entry.sessionId === route.sessionId) ?? null;
    if (thread) return { kind: "thread", thread };
  }
  if (route.selectedAgentId) {
    const thread = threads.find((entry) => entry.agentId === route.selectedAgentId) ?? null;
    if (thread) return { kind: "thread", thread };
    const session = sessions.find((entry) => !entry.sessionId && entry.agentId === route.selectedAgentId) ?? null;
    if (session) return { kind: "session", session };
  }
  return null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="pi-stat">
      <span className="pi-statLabel">{label}</span>
      <span className="pi-statValue">{value}</span>
    </span>
  );
}

export function ProjectsThreadAside({
  route,
  navigate,
}: {
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
}) {
  const { model, nowMs, loading, error } = useProjectsInbox(route);

  // The inspector earns its place for agent/thread/session peeks. The center
  // stays a project/session list; selected session identity and actions belong
  // in this shell sidebar.
  if (!route.sessionId && !route.selectedAgentId) return null;

  const selection = findSelection(model.threads, model.sessions, route);
  if (!selection) {
    return (
      <div className="s-pi s-pi-aside">
        <header className="pi-asideHead">
          <div className="pi-asideIdent">
            <div className="pi-asideTop">
              <span className="pi-asideName">
                {loading ? "Resolving selection" : error ? "Project data unavailable" : "Selection unavailable"}
              </span>
            </div>
            <div className="pi-asideSub">
              <span className="pi-asideStatus" data-tone={loading ? "working" : "recent"}>
                {loading ? <span className="pi-asidePulse" aria-hidden /> : null}
                {loading ? "loading" : "idle"}
              </span>
            </div>
          </div>
        </header>
        <div className="pi-asideBody">
          <p className="pi-asideMuted">
            {error ?? "The selected item is not in the current project snapshot."}
          </p>
        </div>
      </div>
    );
  }

  const thread = selection.kind === "thread" ? selection.thread : null;
  const session = selection.kind === "session" ? selection.session : null;
  const agentName = thread?.agentName ?? session?.agentName ?? "Session";
  const harness = thread?.harness ?? session?.harness ?? "session";
  const projectTitle = thread?.projectTitle ?? session?.projectTitle ?? route.projectSlug ?? "project";
  const branch = thread?.branch ?? session?.branch ?? null;
  const working = thread?.working ?? session?.working ?? false;
  const statusTone = thread?.needs ? "needs" : working ? "working" : "recent";
  const statusLabel = thread?.needs ? "your turn" : working ? "working" : session ? "selected" : "idle";
  const headline = thread?.work ?? session?.work ?? "No session detail available.";
  const lastActivityAt = thread?.lastActivityAt ?? session?.lastActivityAt ?? 0;
  const sessionRef = session?.sessionId ?? thread?.sessionId ?? null;
  const projectRoot = thread?.projectRoot ?? session?.projectRoot ?? null;
  const observeRoute = thread ? threadObserveRoute(thread, route) : null;
  const primaryRoute = thread ? threadOpenRoute(thread, route) : session ? sessionOpenRoute(session, route) : route;
  const primaryLabel = session
    ? session.route?.view === "conversation"
      ? "Open conversation"
      : session.route?.view === "sessions"
        ? "Open session"
        : session.agentId
          ? "Open agent"
          : "Open project"
    : thread?.kind === "native"
      ? "Open session"
      : thread?.conversationId
        ? "Open conversation"
        : "Open agent";
  const clearRoute: Extract<Route, { view: "agents-v2" }> = {
    view: "agents-v2",
    ...(route.projectSlug ? { projectSlug: route.projectSlug } : {}),
    ...(route.indexView ? { indexView: route.indexView } : {}),
    ...(route.machineId ? { machineId: route.machineId } : {}),
    ...(route.showEphemeral ? { showEphemeral: true } : {}),
  };

  return (
    <div className="s-pi s-pi-aside">
      <header className="pi-asideHead">
        <span className="pi-asideAvatar">
          <AgentAvatar
            agent={{ name: agentName, harness, state: working ? "in_turn" : null }}
            placement="row"
            size={38}
          />
        </span>
        <div className="pi-asideIdent">
          <div className="pi-asideTop">
            <span className="pi-asideName" title={agentName}>
              {agentName}
            </span>
            <span className="pi-asideHmark" aria-hidden>
              <HarnessMark harness={harness} size={13} />
            </span>
            <span className="pi-asideProj">/{projectTitle}</span>
          </div>
          <div className="pi-asideSub">
            {branch ? <span className="pi-asideBranch">{branch}</span> : null}
            <span className="pi-asideStatus" data-tone={statusTone}>
              {working ? <span className="pi-asidePulse" aria-hidden /> : null}
              {statusLabel}
            </span>
          </div>
        </div>
      </header>

      <div className="pi-asideBody">
        <h2 className="pi-asideHeadline">{headline}</h2>

        <div className="pi-asideReadouts">
          <Stat label="Last active" value={lastActivityAt ? timeAgo(lastActivityAt, nowMs) : "—"} />
          <Stat label={session ? "Session" : "Conversations"} value={session ? "1" : String(thread?.sessionCount ?? 0)} />
          <Stat label="Harness" value={harness} />
          {thread?.contextPct != null ? <Stat label="Context" value={`${thread.contextPct}%`} /> : null}
        </div>

        {session ? (
          <div className="pi-asideSection">
            <div className="pi-asideSectionHead">Session context</div>
            <div className="pi-asideLine">
              {sessionRef ? <span title={sessionRef}>ref · {sessionRef}</span> : <span>No stable session reference yet.</span>}
              {projectRoot ? <span title={projectRoot}>root · {shortHomePath(projectRoot)}</span> : null}
              {session.conversationId ? <span title={session.conversationId}>conversation · {session.conversationId}</span> : null}
            </div>
          </div>
        ) : null}

        <div className="pi-asideActions">
          <button type="button" className="pi-asideBtn pi-asideBtnPrimary" onClick={() => navigate(primaryRoute)}>
            {primaryLabel}
            <ArrowUpRight size={13} strokeWidth={2} aria-hidden />
          </button>
          {observeRoute ? (
            <button type="button" className="pi-asideBtn" onClick={() => navigate(observeRoute)}>
              Observe
              <ArrowUpRight size={13} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
          <button type="button" className="pi-asideBtn" onClick={() => navigate(clearRoute)}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
