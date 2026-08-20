import { useEffect, useMemo, useRef, useState } from "react";
import "./agents-project.css";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";

import { AgentSessions } from "./AgentSessions.tsx";
import { api } from "../../lib/api.ts";
import { useContextMenu, type MenuItem } from "../../components/ContextMenu.tsx";
import {
  branchesInFlightForProject,
  groupsForProject,
  partitionGroups,
  type ProjectAgentGroup,
} from "./agents-project-model.ts";
import type {
  Agent,
  FleetAsk,
  FleetState,
  HarnessTopologySnapshot,
  Route,
  SessionEntry,
  TailDiscoverySnapshot,
} from "../../lib/types.ts";
import {
  buildDirProjects,
  buildNativeSessionRows,
  dirProjectWorking,
  rowForAgentInventory,
  type AgentInventoryRow,
  type DirProject,
} from "./model.ts";

/* ──────────────────────────────────────────────────────────────────────────
   Agents · Project view — the DETAIL pane when you focus ONE project.

   Ported from the signed-off studio study (design/studio/.../agents-project):
   the project's broker rows collapse up by agent NAME (one recognizable agent
   surfaces under many rows — branch, worktree, clone, session), the ephemeral
   tail folds away, and decorations are stripped so type weight, spacing, and a
   single accent dot carry the hierarchy. One accent as a precedence ladder:
   needs-you ▸ live ▸ idle.

   The spine is project → agent → session, rendered through the REAL shell
   slots: the projects rail lives in the left lane (AgentsLeft); this is the
   center master (masthead · digest · find · agents table); and picking an
   agent drives the REAL right inspector (AgentsInspector) via the route —
   no page-local rail. Selection rides route.agentId, the project rides
   route.projectSlug, and the center stays the directory (master-detail).
   ────────────────────────────────────────────────────────────────────────── */

const LIVE_WINDOW = 30 * 60_000;


const harnessOf = (h: string) => (h === "pi" ? "grok" : h);
const shortModel = (m: string | null) =>
  m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : null;

export function AgentsLibrary({
  agents,
  fleet,
  sessionByAgentId,
  sessions,
  discovery,
  loading,
  navigate,
  selectedAgentId,
}: {
  agents: Agent[];
  fleet: FleetState | null;
  sessionByAgentId: Map<string, SessionEntry>;
  conversationByAgentId: Map<string, string>;
  sessions: SessionEntry[];
  discovery: TailDiscoverySnapshot | null;
  loading: boolean;
  topologySnapshot: HarnessTopologySnapshot | null;
  navigate: (r: Route) => void;
  // The route-selected agent, so the table can highlight the active row while
  // the REAL inspector renders its card + sessions.
  selectedAgentId?: string;
}) {
  const { route, reload, openContextCapture } = useScout();
  const selectedSlug = route.view === "agents-v2" ? route.projectSlug : undefined;

  const activeAsksByAgent = useMemo(() => {
    const byAgent = new Map<string, FleetAsk[]>();
    for (const ask of fleet?.activeAsks ?? []) {
      const list = byAgent.get(ask.agentId) ?? [];
      list.push(ask);
      byAgent.set(ask.agentId, list);
    }
    return byAgent;
  }, [fleet?.activeAsks]);

  const rows = useMemo(
    () =>
      agents.map((agent) =>
        rowForAgentInventory(
          agent,
          sessionByAgentId.get(agent.id) ?? null,
          activeAsksByAgent.get(agent.id) ?? [],
        ),
      ),
    [activeAsksByAgent, agents, sessionByAgentId],
  );

  const nativeSessions = useMemo(() => buildNativeSessionRows(discovery, Date.now()), [discovery]);
  const projects = useMemo(
    () => buildDirProjects(rows, sessions, nativeSessions),
    [rows, sessions, nativeSessions],
  );

  const selected = useMemo(
    () => projects.find((p) => p.slice.slug === selectedSlug) ?? projects[0] ?? null,
    [projects, selectedSlug],
  );



  // Two gestures only, both route-driven — no Provider/shell hacks:
  //   selectAgent  — master-detail. Sets route.agentId (project preserved), so
  //                  the shell un-collapses the inspector while the center stays
  //                  the directory and the table highlights the picked row.
  //   openAgentPage — leave the directory for the agent's full profile page.
  const projectSlug = selected?.slice.slug;
  const gestures: Gestures = {
    selectAgent: (row) =>
      navigate({
        view: "agents-v2",
        agentId: row.agent.id,
        ...(projectSlug ? { projectSlug } : {}),
      }),
    openAgentPage: (row) =>
      navigate({ view: "agents-v2", agentId: row.agent.id, tab: "profile" }),
    startSession: (row) => openContextCapture({
      intent: "new-task",
      projectPath: row.agent.projectRoot ?? row.agent.cwd ?? undefined,
    }),
    openSession: (sessionRoute) => navigate(sessionRoute),
    // Retarget reuses the existing agent config editor (model/cwd/harness/…).
    configureAgent: (row) =>
      navigate({ view: "agents-v2", agentId: row.agent.id, tab: "config" }),
    restartAgent: (row) => {
      void api(`/api/agents/${encodeURIComponent(row.agent.id)}/config`, {
        method: "POST",
        body: JSON.stringify({ restart: true }),
      }).catch(() => {});
    },
    stopAgent: (row) => {
      void api(`/api/agents/${encodeURIComponent(row.agent.id)}/interrupt`, {
        method: "POST",
        body: JSON.stringify({}),
      }).catch(() => {});
    },
    archiveAgent: (row) => {
      void api(`/api/agents/${encodeURIComponent(row.agent.id)}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived: true }),
      })
        .then(() => reload())
        .catch(() => {});
    },
  };

  if (!selected && loading) {
    return (
      <div className="s-aproj" aria-busy="true">
        <div className="ap-loading" role="status" aria-label="Loading agents">
          {Array.from({ length: 7 }, (_, index) => (
            <span key={index} aria-hidden="true" />
          ))}
        </div>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="s-aproj">
        <div className="ap-empty">
          No agents discovered yet — they appear here as harnesses register and work.
        </div>
      </div>
    );
  }

  return (
    <div className="s-aproj">
      <ProjectDetail
        project={selected}
        selectedAgentId={selectedAgentId}
        gestures={gestures}
        sessions={sessions}
      />
    </div>
  );
}

type Gestures = {
  // Master-detail select — drive the REAL inspector with the agent's card.
  selectAgent: (row: AgentInventoryRow) => void;
  // Open ↗ — the agent's full profile page.
  openAgentPage: (row: AgentInventoryRow) => void;
  startSession: (row: AgentInventoryRow) => void;
  // Open a session straight from the directory (sessions are a core flow here).
  openSession: (route: Route) => void;
  // Agents aren't immutable nameplates — these mutate the running agent.
  configureAgent: (row: AgentInventoryRow) => void; // retarget model/cwd/harness
  restartAgent: (row: AgentInventoryRow) => void;
  stopAgent: (row: AgentInventoryRow) => void;
  archiveAgent: (row: AgentInventoryRow) => void; // hide from the directory
};

/* ── icons (kept to two, hairline weight) ──────────────────────────────── */
function IcoSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function Dot({ tone }: { tone: "needs" | "live" | "idle" }) {
  if (tone === "idle") return null;
  return <span className="ap-dot" data-tone={tone} aria-hidden />;
}

/* ── one agent (rolled up from the project's broker rows) ───────────────────
   The row is the master: a click selects the agent into the REAL inspector
   (the inspector owns the session detail now — no in-place accordion). The
   secondary line is ONE noun (sessions), the branch named once; instances and
   conversation counts are not split out here. */
function AgentRow({
  g,
  gestures,
  sessions,
  selected,
  cursor,
  rowRef,
}: {
  g: ProjectAgentGroup;
  gestures: Gestures;
  sessions: SessionEntry[];
  selected: boolean;
  cursor: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const openMenu = useContextMenu();
  const live = Date.now() - g.lastActivityAt < LIVE_WINDOW;
  const tone: "needs" | "live" | "idle" = g.needs ? "needs" : live ? "live" : "idle";
  const lead = g.nodes[0];
  if (!lead) return null;
  // The @ wants a real handle, not a spaced display name — so `@pages-tail`
  // reads as the parallel of `/openscout`, not "@Pages Tail".
  const handle = lead.row.agent.handle?.trim() || g.name;
  // Honest state — an agent runs across several branches/models; surface the
  // spread instead of flattening to branches[0]/model.
  const branches = g.branches.length > 0 ? g.branches : ["main"];
  const multiBranch = branches.length > 1;
  const branchLabel = multiBranch ? `${branches.length} branches` : branches[0];
  const models = [
    ...new Set(g.nodes.map((n) => n.row.agent.model).filter((m): m is string => Boolean(m))),
  ];
  const multiModel = models.length > 1;
  // The agent is mutable, not a frozen nameplate — retarget/restart/stop live
  // behind ⋯. (Rename/archive have no backend yet, so they're not offered.)
  const actions: MenuItem[] = [
    { kind: "action", label: "Configure…", onSelect: () => gestures.configureAgent(lead.row) },
    { kind: "action", label: "Restart", onSelect: () => gestures.restartAgent(lead.row) },
    { kind: "separator" },
    { kind: "action", label: "Stop", onSelect: () => gestures.stopAgent(lead.row) },
    { kind: "action", label: "Archive", onSelect: () => gestures.archiveAgent(lead.row) },
  ];

  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className="ap-row"
      data-tone={tone}
      data-selected={selected || undefined}
      data-cursor={cursor || undefined}
    >
      <div className="ap-rowMain" onClick={() => gestures.selectAgent(lead.row)}>
        <div className="ap-rowBody">
          <div className="ap-rowTop">
            <Dot tone={tone} />
            <span className="ap-rowName" data-idle={tone === "idle" || undefined}>
              <span className="ap-sigil" aria-hidden>@</span>{handle}
            </span>
            <span className="ap-rowMark" aria-hidden>
              <HarnessMark harness={harnessOf(g.harness)} size={11} />
            </span>
            {g.needs ? (
              <span className="ap-needsWord">needs you</span>
            ) : tone === "live" ? (
              <span className="ap-rowState">working</span>
            ) : null}
          </div>
          <div className="ap-rowMeta">
            <span
              className="ap-rowBranch"
              data-dim
              title={multiBranch ? branches.join(" · ") : undefined}
            >
              {branchLabel}
            </span>
            {multiModel ? (
              <>
                <span className="ap-rowDivider" aria-hidden />
                <span className="ap-rowDim" title={models.join(" · ")}>
                  {models.length} models
                </span>
              </>
            ) : null}
            {g.sessionCount ? (
              <>
                <span className="ap-rowDivider" aria-hidden />
                <span className="ap-rowDim">
                  {g.sessionCount} session{g.sessionCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {/* tail lane — reserved width; ago/model by default, actions on hover/needs.
            ⋯ sits outside the hover-swap so the agent always reads as actionable. */}
        <div className="ap-rowTailWrap">
          <div className="ap-rowTail">
            <div className="ap-tailMeta" aria-hidden={tone === "needs" || undefined}>
              <span className="ap-rowAgo">{g.lastActivityAt ? timeAgo(g.lastActivityAt) : "—"}</span>
              {!multiModel && shortModel(g.model) ? (
                <span className="ap-rowModel">{shortModel(g.model)}</span>
              ) : null}
            </div>
            <div className="ap-rowActions">
              <button
                type="button"
                className="ap-act ap-actPrimary"
                onClick={(e) => {
                  e.stopPropagation();
                  gestures.openAgentPage(lead.row);
                }}
              >
                Open ↗
              </button>
              <button
                type="button"
                className="ap-act"
                onClick={(e) => {
                  e.stopPropagation();
                  gestures.startSession(lead.row);
                }}
              >
                ＋ Session
              </button>
            </div>
          </div>
          <button
            type="button"
            className="ap-rowMore"
            aria-label="Agent actions"
            title="Configure · restart · stop"
            onClick={(e) => {
              e.stopPropagation();
              openMenu(e, actions);
            }}
          >
            ⋯
          </button>
        </div>
      </div>
      {/* the agent's sessions — work-led rows that expand IN PLACE into the full
          instrument (session id · branch · context · tools · files touched). */}
      <AgentSessions agentIds={g.nodes.map((n) => n.row.agent.id)} sessions={sessions} />
    </div>
  );
}

/* ── project view ──────────────────────────────────────────────────────────
   A single center column (masthead · digest · resume · find · agents table).
   No second rail: selection drives the REAL shell inspector via the route. */
function ProjectDetail({
  project,
  selectedAgentId,
  gestures,
  sessions,
}: {
  project: DirProject;
  selectedAgentId?: string;
  gestures: Gestures;
  sessions: SessionEntry[];
}) {
  const [q, setQ] = useState("");
  const [harness, setHarness] = useState<string | null>(null);
  const [showEph, setShowEph] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const findRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const groups = useMemo(() => groupsForProject(project), [project]);
  const { primary: primaryGroups, ephemeral: ephGroups } = useMemo(
    () => partitionGroups(groups),
    [groups],
  );
  const flight = useMemo(() => branchesInFlightForProject(project), [project]);
  const harnesses = useMemo(
    () => [...new Set(primaryGroups.map((g) => harnessOf(g.harness)))],
    [primaryGroups],
  );

  const query = q.trim().toLowerCase();
  const match = (g: ProjectAgentGroup) =>
    (!harness || harnessOf(g.harness) === harness) &&
    (!query ||
      g.name.toLowerCase().includes(query) ||
      g.branches.some((b) => b.toLowerCase().includes(query)) ||
      g.harness.includes(query));

  const primary = primaryGroups.filter(match);
  const ephemeral = ephGroups.filter(match);
  const filtering = Boolean(query || harness);
  const lead = primary.find((g) => g.needs) ?? primary[0];
  const needsAgent = primary.some((g) => g.needs);

  // A project that rolls up to a single real agent has nothing to organize —
  // the find + resume bands are noise, so drop them for the lone agent.
  const sparse = primaryGroups.length <= 1;

  const working = dirProjectWorking(project);
  // Count the SAME population the rows show (sum of per-agent sessions), so the
  // digest agrees with the "N sessions" on each agent row — one noun, one number.
  const sessionCount = groups.reduce((total, group) => total + group.sessionCount, 0);

  const isSelected = (g: ProjectAgentGroup) =>
    Boolean(selectedAgentId && g.nodes.some((n) => n.row.agent.id === selectedAgentId));

  // keyboard layer — j/k or ↑/↓ scrub a cursor down the roster, ↵ selects the
  // cursor row into the inspector, ⌘↵ jumps to whoever needs you, ⌘K // / focus
  // search, Esc blurs the field. Inputs are guarded.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if ((e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
        return;
      }
      if (e.key === "Escape") {
        if (typing) el?.blur();
        return;
      }
      if (typing) return;

      const max = primary.length;
      if (!max) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setCursor((c) => (c < 0 ? 0 : Math.min(max - 1, c + 1)));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setCursor((c) => (c < 0 ? 0 : Math.max(0, c - 1)));
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        const target = primary.find((g) => g.needs) ?? primary[0];
        if (target) {
          e.preventDefault();
          setCursor(primary.indexOf(target));
          gestures.selectAgent(target.nodes[0].row);
        }
      } else if (e.key === "Enter") {
        const i = cursor < 0 ? 0 : cursor;
        const target = primary[i];
        if (target) {
          e.preventDefault();
          setCursor(i);
          gestures.selectAgent(target.nodes[0].row);
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [primary, cursor, gestures]);

  // keep the cursor in range as filtering shrinks the roster, and reveal it.
  useEffect(() => {
    if (cursor < 0) return;
    if (cursor >= primary.length) {
      setCursor(primary.length - 1);
      return;
    }
    rowRefs.current.get(primary[cursor]?.name ?? "")?.scrollIntoView({ block: "nearest" });
  }, [cursor, primary]);

  return (
    <div className="ap-view">
      <div className="ap-content">
        {/* masthead */}
        <header className="ap-head">
          <SpriteAvatar name={project.slice.title} size={56} tile />
          <div className="ap-headIdent">
            <div className="ap-headTop">
              <h1 className="ap-headName"><span className="ap-sigil" aria-hidden>/</span>{project.slice.title}</h1>
            </div>
            {project.slice.root ? <span className="ap-headRoot">{project.slice.root}</span> : null}
          </div>
          <div className="ap-headActions">
            <button
              type="button"
              className="ap-headCta"
              disabled={!lead}
              onClick={() => lead && gestures.startSession(lead.nodes[0].row)}
            >
              ＋ New agent
            </button>
          </div>
        </header>

        {/* digest — one quiet inline line, demoted (the agent + session content
            below is what's elevated). Zero-value stats stay out of the line. */}
        <div className="ap-digest">
          <span className="ap-stat">
            <span className="ap-statNum">{primaryGroups.length}</span>
            <span className="ap-statLbl">{primaryGroups.length === 1 ? "agent" : "agents"}</span>
          </span>
          <span className="ap-stat">
            <span className="ap-statNum">{sessionCount}</span>
            <span className="ap-statLbl">{sessionCount === 1 ? "session" : "sessions"}</span>
          </span>
          {flight.length > 0 ? (
            <span className="ap-stat">
              <span className="ap-statNum">{flight.length}</span>
              <span className="ap-statLbl">in flight</span>
            </span>
          ) : null}
          <span className="ap-statMarks">
            {harnesses.map((h) => (
              <span key={h} title={h} aria-hidden>
                <HarnessMark harness={h} size={12} />
              </span>
            ))}
          </span>
        </div>

        {/* resume line — pick up where it left off (no box, accent dot) */}
        {lead && !filtering && !sparse ? (
          <div className="ap-resume" data-tone={lead.needs ? "needs" : "live"} aria-live="polite">
            <span className="ap-dot" data-tone={lead.needs ? "needs" : "live"} aria-hidden />
            <span className="ap-resumeLbl">{lead.needs ? "Waiting on you" : "Most recent"}</span>
            <span className="ap-resumeWho">
              <span className="ap-sigil" aria-hidden>@</span>
              {lead.nodes[0].row.agent.handle?.trim() || lead.name}
            </span>
            <span className="ap-resumeMeta">
              {lead.branches[0] ?? "main"} · {lead.lastActivityAt ? timeAgo(lead.lastActivityAt) : "—"}
            </span>
            <span className="ap-resumeActions">
              <button
                type="button"
                className="ap-linkAccent"
                onClick={() => gestures.selectAgent(lead.nodes[0].row)}
              >
                {lead.needs ? "Continue" : "Resume"}
              </button>
              <button type="button" className="ap-link" onClick={() => gestures.openAgentPage(lead.nodes[0].row)}>
                Open ↗
              </button>
            </span>
          </div>
        ) : null}

        {/* find — underline field + plain harness toggles (hidden when there's
            only one agent to organize) */}
        {!sparse ? (
          <div className="ap-find">
            <span className="ap-findIco" aria-hidden>
              <IcoSearch />
            </span>
            <input
              ref={findRef}
              className="ap-findInput"
              placeholder="Find an agent, branch, or harness…  (⌘K)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="ap-findFilters">
              {harnesses.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="ap-filter"
                  data-on={harness === h || undefined}
                  onClick={() => setHarness((cur) => (cur === h ? null : h))}
                >
                  <HarnessMark harness={h} size={11} />
                  {h.charAt(0).toUpperCase() + h.slice(1)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* agents table */}
        <div className="ap-main">
          <div className="ap-sectionHead">
            <span className="ap-sectionTitle">Agents</span>
            <span className="ap-sectionMeta">
              {primary.length} shown{filtering ? " · filtered" : ""}
            </span>
            <span className="ap-kbdHint" aria-hidden>
              ↑↓ move · ↵ open{needsAgent ? " · ⌘↵ needs" : ""}
            </span>
          </div>

          <div className="ap-roster">
            {primary.map((g, idx) => (
              <AgentRow
                key={g.name}
                g={g}
                gestures={gestures}
                sessions={sessions}
                selected={isSelected(g)}
                cursor={cursor === idx}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(g.name, el);
                  else rowRefs.current.delete(g.name);
                }}
              />
            ))}
            {primary.length === 0 ? (
              <div className="ap-empty">
                {filtering
                  ? "No agents match."
                  : ephemeral.length
                    ? "No primary agents — workflow & clone agents are in the fold below."
                    : "No agents in this project yet."}
              </div>
            ) : null}
          </div>

          {ephemeral.length ? (
            <div className="ap-ephBlock">
              <button type="button" className="ap-ephToggle" onClick={() => setShowEph((v) => !v)}>
                <span className="ap-ephCount">{ephemeral.length}</span> ephemeral · workflow &amp; clone agents
                <span className="ap-ephCaret">{showEph ? "▴" : "▾"}</span>
              </button>
              {showEph ? (
                <div className="ap-ephList">
                  {ephemeral.map((g) => (
                    <button
                      key={g.name}
                      type="button"
                      className="ap-ephRow"
                      onClick={() => gestures.openAgentPage(g.nodes[0].row)}
                    >
                      <span className="ap-ephMark" aria-hidden>
                        <HarnessMark harness={harnessOf(g.harness)} size={10} />
                      </span>
                      <span className="ap-ephName">{g.name}</span>
                      <span className="ap-ephBranch">{g.branches[0] ?? "main"}</span>
                      <span className="ap-ephAgo">{g.lastActivityAt ? timeAgo(g.lastActivityAt) : "—"}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            className="ap-newAgent"
            disabled={!lead}
            onClick={() => lead && gestures.startSession(lead.nodes[0].row)}
          >
            ＋ New agent on this project
          </button>
        </div>
      </div>
    </div>
  );
}
