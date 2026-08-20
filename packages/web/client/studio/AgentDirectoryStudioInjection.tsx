import type { ReactNode } from "react";

import { StudioInjectionFrame } from "./studio-injection.tsx";
import "./agent-directory-studio-injection.css";

type StudyAgentState = "working" | "ready" | "attention" | "offline";

interface StudyAgent {
  id: string;
  name: string;
  handle: string;
  state: StudyAgentState;
  role: string;
  branch: string;
  task: string;
  last: string;
}

interface StudyProject {
  id: string;
  title: string;
  root: string;
  signal: string;
  agents: StudyAgent[];
  sessions: number;
}

const STUDY_PROJECTS: StudyProject[] = [
  {
    id: "openscout",
    title: "openscout",
    root: "~/dev/openscout",
    signal: "Studio mode injection for agent directory",
    sessions: 9,
    agents: [
      {
        id: "hudson",
        name: "Hudson",
        handle: "@hudson",
        state: "working",
        role: "web design system",
        branch: "feat/studio-mode",
        task: "Refactoring the agent directory into insertion points",
        last: "18s",
      },
      {
        id: "scout",
        name: "Scout",
        handle: "@scout",
        state: "attention",
        role: "operator assistant",
        branch: "main",
        task: "Needs placement decision",
        last: "1m",
      },
      {
        id: "quill",
        name: "Quill",
        handle: "@quill",
        state: "ready",
        role: "docs",
        branch: "docs/agent-view",
        task: "Ready to write the study summary",
        last: "7m",
      },
    ],
  },
  {
    id: "hudson",
    title: "hudson",
    root: "~/dev/hudson",
    signal: "Slot contracts and chrome primitives",
    sessions: 4,
    agents: [
      {
        id: "atlas",
        name: "Atlas",
        handle: "@atlas",
        state: "working",
        role: "framework",
        branch: "slots/studio-anchor",
        task: "Mapping chrome slots to page anchors",
        last: "3m",
      },
      {
        id: "mira",
        name: "Mira",
        handle: "@mira",
        state: "ready",
        role: "qa",
        branch: "main",
        task: "Idle",
        last: "12m",
      },
    ],
  },
  {
    id: "lattices",
    title: "lattices",
    root: "~/dev/lattices",
    signal: "macOS web view parity pass",
    sessions: 2,
    agents: [
      {
        id: "north",
        name: "North",
        handle: "@north",
        state: "offline",
        role: "native",
        branch: "main",
        task: "No active session",
        last: "1h",
      },
    ],
  },
];

const STATE_LABELS: Record<StudyAgentState, string> = {
  working: "working",
  ready: "ready",
  attention: "attention",
  offline: "offline",
};

export function AgentDirectoryStudioInjection({ children }: { children: ReactNode }) {
  return (
    <StudioInjectionFrame
      studyId="agent-directory"
      aliases={["agents", "agent", "agent-directory-before-after"]}
      anchor="agents.directory"
      title="Agent Directory"
      renderStudy={() => <InjectedAgentDirectoryStudy />}
    >
      {children}
    </StudioInjectionFrame>
  );
}

function InjectedAgentDirectoryStudy() {
  const agents = STUDY_PROJECTS.flatMap((project) => project.agents);
  const working = agents.filter((agent) => agent.state === "working");
  const ready = agents.filter((agent) => agent.state === "ready");
  const attention = agents.filter((agent) => agent.state === "attention");
  const sessions = STUDY_PROJECTS.reduce((sum, project) => sum + project.sessions, 0);
  const pinnedAgent = working[0] ?? agents[0]!;

  return (
    <section className="s-agent-studio-study" aria-label="Agent directory injected study">
      <div className="s-agent-studio-banner">
        <span>After study</span>
        <strong>Injected static view inside the live Agents route</strong>
        <em>Fixture data · insertion-point prototype · no backend writes</em>
      </div>
      <header className="s-agent-studio-head" data-studio-anchor="agent.directory.header">
        <div className="s-agent-studio-title-block">
          <span className="s-agent-studio-kicker">Studio / agents.directory / after</span>
          <h1 className="s-agent-studio-title">Project command center</h1>
          <span className="s-agent-studio-subtitle">
            {agents.length} agents across {STUDY_PROJECTS.length} projects
          </span>
        </div>
        <div className="s-agent-studio-metrics" aria-label="Agent study summary">
          <Metric label="working" value={working.length} tone="working" />
          <Metric label="ready" value={ready.length} />
          <Metric label="attention" value={attention.length} tone="attention" />
          <Metric label="sessions" value={sessions} />
        </div>
      </header>

      <div className="s-agent-studio-layout">
        <div className="s-agent-studio-main">
          <section className="s-agent-studio-pressure" data-studio-anchor="agent.active-strip">
            <div className="s-agent-studio-section-head">
              <span>Pressure queue</span>
              <strong>{working.length + attention.length}</strong>
            </div>
            <div className="s-agent-studio-pressure-list">
              {[...working, ...attention].map((agent) => (
                <article key={agent.id} className={`s-agent-studio-pressure-card s-agent-studio-pressure-card--${agent.state}`}>
                  <span className="s-agent-studio-dot" data-state={agent.state} />
                  <div className="s-agent-studio-pressure-copy">
                    <strong>{agent.name}</strong>
                    <span>{agent.task}</span>
                  </div>
                  <time>{agent.last}</time>
                </article>
              ))}
            </div>
          </section>

          <section className="s-agent-studio-projects" data-studio-anchor="agent.project-board">
            {STUDY_PROJECTS.map((project) => (
              <article key={project.id} className="s-agent-studio-project">
                <div className="s-agent-studio-project-main">
                  <div>
                    <span className="s-agent-studio-project-root">{project.root}</span>
                    <h2>{project.title}</h2>
                  </div>
                  <span className="s-agent-studio-project-sessions">{project.sessions} sessions</span>
                </div>
                <p>{project.signal}</p>
                <div className="s-agent-studio-agent-row">
                  {project.agents.map((agent) => (
                    <span key={agent.id} className={`s-agent-studio-agent-pill s-agent-studio-agent-pill--${agent.state}`}>
                      <span className="s-agent-studio-dot" data-state={agent.state} />
                      {agent.name}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </section>
        </div>

        <aside className="s-agent-studio-detail" data-studio-anchor="agent.detail-preview">
          <span className="s-agent-studio-kicker">Pinned agent</span>
          <h2>{pinnedAgent.name}</h2>
          <span className={`s-agent-studio-state s-agent-studio-state--${pinnedAgent.state}`}>
            {STATE_LABELS[pinnedAgent.state]}
          </span>
          <dl>
            <div>
              <dt>Handle</dt>
              <dd>{pinnedAgent.handle}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{pinnedAgent.role}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{pinnedAgent.branch}</dd>
            </div>
            <div>
              <dt>Current task</dt>
              <dd>{pinnedAgent.task}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "working" | "attention";
}) {
  return (
    <div className={`s-agent-studio-metric${tone ? ` s-agent-studio-metric--${tone}` : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
