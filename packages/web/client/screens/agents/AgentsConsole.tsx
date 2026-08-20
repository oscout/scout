import { useMemo, useState, type ReactNode } from "react";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark, harnessLabel } from "../../components/HarnessMark.tsx";
import { agentStateLabel } from "../../lib/agent-state.ts";
import { formatLabel } from "../../lib/text.ts";
import { timeAgo } from "../../lib/time.ts";
import type { Agent, SessionEntry } from "../../lib/types.ts";
import "./agents-console.css";

/**
 * AgentsConsole — the agent *operations console*.
 *
 * A three-pane, filesystem-flavored browser: a tree of agents grouped by
 * project (left), the selected agent facet rendered as a reading pane
 * (center), and a stable agent-facts rail (right). It is the real-data
 * descendant of the "agents directory" design canvas — but every field here is
 * backed by the live agent model, so it maps 1:1 onto shippable code.
 *
 * (Distinct from the `.s-dir` AgentsDirectory / useAgentDirectory work on this
 * branch, which is the project-navigator master/detail rebuild. This is the
 * filesystem/definitions take: an agent as a browsable set of facets.)
 *
 * Where the design canvas treated an agent as a folder of authored files
 * (AGENT.md / config.yaml / tools/*.ts / README.md), OpenScout has no such
 * files. So the "files" are rebound to the agent's REAL facets:
 *
 *   System prompt  ← config.systemPrompt        (GET/POST /api/agents/:id/config)
 *   Config         ← harness · model · perms · caps · launch args   (same route)
 *   Conversations  ← the agent's SessionEntry[]  (/api/conversations, linked by id)
 *   Context        ← live context-window usage   (/api/agents/:id/session/context)
 *
 * Deliberately NOT shown (absent from the model — named, not faked): structured
 * mission/guardrails sections, agent.config.yaml fields (temperature, max_turns,
 * mcp_servers, secrets), per-agent tool source files, per-agent README, a
 * version SHA, and frontmatter triggers.
 *
 * Color discipline follows the agents-project port: one accent, spent only as
 * the precedence dot (needs-you ▸ live ▸ idle). Working-vs-idle otherwise reads
 * from the SpriteAvatar's own state brightness and from text contrast — never a
 * categorical status palette.
 */

export type ConsoleFacet = "prompt" | "config" | "conversations" | "context";

export type ConsoleStatus = "in_turn" | "in_flight" | "callable" | "blocked";

/** The real-config subset this view reads (maps from LocalAgentConfigState). */
export interface ConsoleAgentConfig {
  systemPrompt: string;
  templateHint?: string;
  model: string | null;
  /** A display label for the permission profile (the raw profile is opaque). */
  permission: string | null;
  capabilities: string[];
  launchArgs: string[];
  runtime: { harness: string; transport: string; cwd: string; sessionId: string };
  editable: boolean;
}

/** The real live-context subset this view reads (maps from LocalAgentContextState). */
export interface ConsoleAgentContext {
  state: "fresh" | "aging" | "stale";
  usedPercent: number | null;
  turnCount: number;
  contextInputTokens: number | null;
  contextWindowTokens: number | null;
}

export interface ConsoleAgentEntry {
  agent: Agent;
  status: ConsoleStatus;
  /** activeAskCount > 0 — the one signal that earns the accent. */
  needsYou: boolean;
  activeTask: string | null;
  sessions: SessionEntry[];
  config: ConsoleAgentConfig;
  context: ConsoleAgentContext | null;
  lastActivityAt: number | null;
}

export interface ConsoleProject {
  key: string;
  slug: string;
  title: string;
  root: string | null;
  agents: ConsoleAgentEntry[];
}

export interface AgentsConsoleProps {
  projects: ConsoleProject[];
  /** Initial selection (agent + facet). Defaults to the first agent's prompt. */
  initialSelection?: { agentId: string; facet: ConsoleFacet };
  /** Backed actions — render only the ones you wire. Each maps to a real route. */
  onEdit?: (agentId: string) => void;
  onInterrupt?: (agentId: string) => void;
  onResetContext?: (agentId: string) => void;
  onOpenConversation?: (agentId: string, sessionId?: string) => void;
  onNewAgent?: () => void;
}

type Tone = "needs" | "live" | "idle";

function toneFor(entry: ConsoleAgentEntry): Tone {
  if (entry.needsYou) return "needs";
  if (entry.status === "in_turn" || entry.status === "in_flight") return "live";
  return "idle";
}

const FACETS: { id: ConsoleFacet; label: string; sigil: string }[] = [
  { id: "prompt", label: "System prompt", sigil: "◆" },
  { id: "config", label: "Config", sigil: "▤" },
  { id: "conversations", label: "Conversations", sigil: "◇" },
  { id: "context", label: "Context", sigil: "▸" },
];

const FACET_LABEL: Record<ConsoleFacet, string> = {
  prompt: "System prompt",
  config: "Config",
  conversations: "Conversations",
  context: "Context",
};

function shortRoot(root: string | null): string {
  if (!root) return "";
  return root.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function AgentsConsole({
  projects,
  initialSelection,
  onEdit,
  onInterrupt,
  onResetContext,
  onOpenConversation,
  onNewAgent,
}: AgentsConsoleProps) {
  const allEntries = useMemo(
    () => projects.flatMap((p) => p.agents.map((a) => [p, a] as const)),
    [projects],
  );
  const first = allEntries[0]?.[1];

  const [selId, setSelId] = useState<string | null>(
    initialSelection?.agentId ?? first?.agent.id ?? null,
  );
  const [facet, setFacet] = useState<ConsoleFacet>(initialSelection?.facet ?? "prompt");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(selId ? [selId] : []),
  );
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return projects;
    return projects
      .map((p) => ({
        ...p,
        agents: p.agents.filter(
          (a) =>
            a.agent.name.toLowerCase().includes(q) ||
            (a.agent.harness ?? "").toLowerCase().includes(q) ||
            p.slug.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.agents.length > 0);
  }, [projects, q]);

  const selected = useMemo(() => {
    for (const [project, entry] of allEntries) {
      if (entry.agent.id === selId) return { project, entry };
    }
    return null;
  }, [allEntries, selId]);

  const totalAgents = projects.reduce((n, p) => n + p.agents.length, 0);
  const totalFiles = totalAgents * FACETS.length;

  const selectAgent = (agentId: string, nextFacet?: ConsoleFacet) => {
    setSelId(agentId);
    if (nextFacet) setFacet(nextFacet);
    setExpanded((s) => new Set(s).add(agentId));
  };

  const toggleAgent = (agentId: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
    setSelId(agentId);
  };

  return (
    <div className="s-acon">
      <div className="ac-shell">
        {/* ── LEFT: the agent tree, grouped by project ─────────────────────── */}
        <aside className="ac-tree">
          <div className="ac-treeHead">
            <span className="ac-treeIco" aria-hidden>
              ⌕
            </span>
            <input
              className="ac-treeFind"
              placeholder="Filter agents…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="ac-treeScroll">
            {filtered.map((project) => (
              <div className="ac-treeGroup" key={project.key}>
                <div className="ac-treeProject">
                  <span className="ac-sigil">/</span>
                  {project.slug}
                  <span className="ac-treeProjectCount">{project.agents.length}</span>
                </div>
                {project.agents.map((entry) => {
                  const open = expanded.has(entry.agent.id);
                  const tone = toneFor(entry);
                  const isSel = entry.agent.id === selId;
                  return (
                    <div className="ac-agentBlock" key={entry.agent.id}>
                      <button
                        type="button"
                        className="ac-agent"
                        data-open={open || undefined}
                        onClick={() => toggleAgent(entry.agent.id)}
                      >
                        <span className="ac-agentChev" data-open={open || undefined} aria-hidden>
                          ▸
                        </span>
                        <span className="ac-agentAvatar" aria-hidden>
                          <AgentAvatar
                            agent={{
                              name: entry.agent.name,
                              harness: entry.agent.harness,
                              state: entry.agent.state,
                            }}
                            placement="node"
                            size={16}
                          />
                        </span>
                        <span className="ac-agentName" data-idle={tone === "idle" || undefined}>
                          {entry.agent.name}
                        </span>
                        {tone === "needs" ? <span className="ac-needs">needs you</span> : null}
                        <span className="ac-agentTail">
                          {tone !== "idle" ? (
                            <span className="ac-dot" data-tone={tone} aria-hidden />
                          ) : null}
                          {entry.agent.harness ? (
                            <span className="ac-agentMark" aria-hidden>
                              <HarnessMark harness={entry.agent.harness} size={11} />
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {open ? (
                        <div className="ac-facets">
                          {FACETS.map((f) => {
                            const count =
                              f.id === "conversations" ? entry.sessions.length : undefined;
                            const activeLeaf = isSel && facet === f.id;
                            return (
                              <button
                                type="button"
                                className="ac-facet"
                                key={f.id}
                                data-active={activeLeaf || undefined}
                                onClick={() => selectAgent(entry.agent.id, f.id)}
                              >
                                <span className="ac-facetSigil" aria-hidden>
                                  {f.sigil}
                                </span>
                                <span className="ac-facetLabel">{f.label}</span>
                                {count != null ? (
                                  <span className="ac-facetCount">{count}</span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {onNewAgent ? (
              <button type="button" className="ac-newAgent" onClick={onNewAgent}>
                ＋ new agent
              </button>
            ) : null}
          </div>
        </aside>

        {/* ── CENTER: the reading pane for the selected facet ──────────────── */}
        <main className="ac-read">
          {selected ? (
            <ReadingPane
              project={selected.project}
              entry={selected.entry}
              facet={facet}
              onEdit={onEdit}
              onInterrupt={onInterrupt}
              onResetContext={onResetContext}
              onOpenConversation={onOpenConversation}
            />
          ) : (
            <div className="ac-empty">No agents.</div>
          )}
        </main>

        {/* ── RIGHT: the agent facts rail ──────────────────────────────────── */}
        <aside className="ac-rail">
          {selected ? (
            <FactsRail entry={selected.entry} onOpenConversation={onOpenConversation} />
          ) : null}
        </aside>
      </div>

      {/* footer hint — the filesystem framing made literal, with a real count */}
      <div className="ac-foot">
        <span className="ac-footStat">{plural(projects.length, "project")}</span>
        <span className="ac-footSep">·</span>
        <span className="ac-footStat">{plural(totalAgents, "agent")}</span>
        <span className="ac-footSep">·</span>
        <span className="ac-footStat">{plural(totalFiles, "facet")}</span>
      </div>
    </div>
  );
}

// ── reading pane ────────────────────────────────────────────────────────────

function ReadingPane({
  project,
  entry,
  facet,
  onEdit,
  onInterrupt,
  onResetContext,
  onOpenConversation,
}: {
  project: ConsoleProject;
  entry: ConsoleAgentEntry;
  facet: ConsoleFacet;
  onEdit?: (agentId: string) => void;
  onInterrupt?: (agentId: string) => void;
  onResetContext?: (agentId: string) => void;
  onOpenConversation?: (agentId: string, sessionId?: string) => void;
}) {
  const { agent, config } = entry;
  const running = entry.status === "in_turn" || entry.status === "in_flight";

  return (
    <>
      <header className="ac-readHead">
        <div className="ac-crumb">
          <span className="ac-crumbDim">{project.slug}</span>
          <span className="ac-crumbSep">/</span>
          <span className="ac-crumbAgent">@{agent.name}</span>
          <span className="ac-crumbSep">/</span>
          <span className="ac-crumbFacet">{FACET_LABEL[facet]}</span>
        </div>
        <div className="ac-readActions">
          {(facet === "prompt" || facet === "config") && onEdit && config.editable ? (
            <button type="button" className="ac-actPrimary" onClick={() => onEdit(agent.id)}>
              Edit
            </button>
          ) : null}
          {running && onInterrupt ? (
            <button type="button" className="ac-act" onClick={() => onInterrupt(agent.id)}>
              Interrupt
            </button>
          ) : null}
          {facet === "context" && onResetContext ? (
            <button type="button" className="ac-act" onClick={() => onResetContext(agent.id)}>
              Reset
            </button>
          ) : null}
          {onOpenConversation ? (
            <button type="button" className="ac-act" onClick={() => onOpenConversation(agent.id)}>
              Open ↗
            </button>
          ) : null}
        </div>
      </header>

      <div className="ac-metaStrip">
        <MetaItem k="Type" v={metaType(facet)} />
        {config.model ? <MetaItem k="Model" v={config.model} mono /> : null}
        <MetaItem k="Editable" v={config.editable ? "yes" : "read-only"} />
        {entry.lastActivityAt ? <MetaItem k="Active" v={timeAgo(entry.lastActivityAt)} /> : null}
      </div>

      <div className="ac-readBody">
        {facet === "prompt" ? <PromptFacet entry={entry} /> : null}
        {facet === "config" ? <ConfigFacet entry={entry} /> : null}
        {facet === "conversations" ? (
          <ConversationsFacet entry={entry} onOpenConversation={onOpenConversation} />
        ) : null}
        {facet === "context" ? <ContextFacet entry={entry} /> : null}
      </div>
    </>
  );
}

function metaType(facet: ConsoleFacet): string {
  switch (facet) {
    case "prompt":
      return "Markdown · system prompt";
    case "config":
      return "Runtime config";
    case "conversations":
      return "Conversation list";
    case "context":
      return "Live context window";
  }
}

function PromptFacet({ entry }: { entry: ConsoleAgentEntry }) {
  const { agent, config } = entry;
  const prompt = config.systemPrompt.trim() || config.templateHint || "default template";
  const isDefault = !config.systemPrompt.trim();
  return (
    <div className="ac-doc">
      <div className="ac-docHead">
        <span className="ac-docKey">name</span>
        <span className="ac-docVal">{agent.name}</span>
        {agent.role ? (
          <>
            <span className="ac-docKey">role</span>
            <span className="ac-docVal">{formatLabel(agent.role) ?? agent.role}</span>
          </>
        ) : null}
        <span className="ac-docKey">harness</span>
        <span className="ac-docVal">{harnessLabel(agent.harness)}</span>
        {config.model ? (
          <>
            <span className="ac-docKey">model</span>
            <span className="ac-docVal">{config.model}</span>
          </>
        ) : null}
      </div>
      <div className="ac-docLabel">{isDefault ? "Default template" : "System prompt"}</div>
      <pre className="ac-prose" data-default={isDefault || undefined}>
        {prompt}
      </pre>
    </div>
  );
}

function ConfigFacet({ entry }: { entry: ConsoleAgentEntry }) {
  const { agent, config } = entry;
  return (
    <div className="ac-config">
      <ConfigRow k="Harness">
        <span className="ac-inlineMark">
          <HarnessMark harness={agent.harness} size={12} />
        </span>
        {harnessLabel(agent.harness)}
      </ConfigRow>
      <ConfigRow k="Model">{config.model ?? "—"}</ConfigRow>
      <ConfigRow k="Permissions">{config.permission ?? "default"}</ConfigRow>
      <ConfigRow k="Transport">{config.runtime.transport}</ConfigRow>
      <ConfigRow k="Workdir" mono title={config.runtime.cwd}>
        {shortRoot(config.runtime.cwd) || config.runtime.cwd}
      </ConfigRow>
      <ConfigRow k="Session" mono>
        {config.runtime.sessionId}
      </ConfigRow>
      {config.launchArgs.length ? (
        <div className="ac-configBlock">
          <div className="ac-configKey">Launch</div>
          <pre className="ac-cmd">
            {config.runtime.harness} {config.launchArgs.join(" ")}
          </pre>
        </div>
      ) : null}
      {config.capabilities.length ? (
        <div className="ac-configBlock">
          <div className="ac-configKey">Capabilities</div>
          <div className="ac-chips">
            {config.capabilities.map((c) => (
              <span className="ac-chip" key={c}>
                {c}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConversationsFacet({
  entry,
  onOpenConversation,
}: {
  entry: ConsoleAgentEntry;
  onOpenConversation?: (agentId: string, sessionId?: string) => void;
}) {
  if (!entry.sessions.length) {
    return <div className="ac-empty">No conversations yet.</div>;
  }
  return (
    <div className="ac-convos">
      {entry.sessions.map((s) => (
        <button
          type="button"
          className="ac-convo"
          key={s.id}
          disabled={!onOpenConversation}
          onClick={() => onOpenConversation?.(entry.agent.id, s.id)}
        >
          <span className="ac-convoDot" aria-hidden />
          <span className="ac-convoBody">
            <span className="ac-convoTitle">{s.title || s.preview || "Conversation"}</span>
            {s.preview && s.title ? <span className="ac-convoPreview">{s.preview}</span> : null}
            <span className="ac-convoMeta">
              {s.currentBranch ? <span className="ac-convoBranch">{s.currentBranch}</span> : null}
              <span>{s.messageCount} msgs</span>
              {s.lastMessageAt ? <span>{timeAgo(s.lastMessageAt)}</span> : null}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ContextFacet({ entry }: { entry: ConsoleAgentEntry }) {
  const ctx = entry.context;
  if (!ctx) {
    return <div className="ac-empty">No live context — agent is not in an active session.</div>;
  }
  const pct = ctx.usedPercent != null ? Math.round(ctx.usedPercent) : null;
  return (
    <div className="ac-ctx">
      <div className="ac-ctxTop">
        <span className="ac-ctxState" data-state={ctx.state}>
          {ctx.state}
        </span>
        <span className="ac-ctxTurns">{ctx.turnCount} turns</span>
      </div>
      {pct != null ? (
        <>
          <div className="ac-ctxGauge">
            <span className="ac-ctxFill" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="ac-ctxRead">
            <span className="ac-ctxNum">{pct}%</span>
            <span className="ac-ctxDim">of context window used</span>
          </div>
        </>
      ) : null}
      {ctx.contextInputTokens != null && ctx.contextWindowTokens != null ? (
        <div className="ac-ctxTokens">
          {ctx.contextInputTokens.toLocaleString()} / {ctx.contextWindowTokens.toLocaleString()}{" "}
          tokens
        </div>
      ) : null}
    </div>
  );
}

// ── facts rail ──────────────────────────────────────────────────────────────

function FactsRail({
  entry,
  onOpenConversation,
}: {
  entry: ConsoleAgentEntry;
  onOpenConversation?: (agentId: string, sessionId?: string) => void;
}) {
  const { agent, config } = entry;
  const tone = toneFor(entry);
  const owner = agent.ownerName || agent.ownerHandle || null;

  return (
    <div className="ac-railInner">
      <div className="ac-railIdent">
        <span className="ac-railAvatar" aria-hidden>
          <AgentAvatar
            agent={{ name: agent.name, harness: agent.harness, state: agent.state }}
            placement="inspector"
          />
        </span>
        <div className="ac-railNames">
          <div className="ac-railName">@{agent.name}</div>
          {agent.role ? <div className="ac-railRole">{formatLabel(agent.role) ?? agent.role}</div> : null}
        </div>
      </div>

      <div className="ac-railState" data-tone={tone === "idle" ? undefined : tone}>
        {tone !== "idle" ? <span className="ac-dot" data-tone={tone} aria-hidden /> : null}
        <span>{entry.needsYou ? "Needs you" : agentStateLabel(agent.state)}</span>
      </div>
      {entry.activeTask ? <div className="ac-railTask">{entry.activeTask}</div> : null}

      <div className="ac-railGroup">
        <RailFact k="Harness" v={harnessLabel(agent.harness)} mark={agent.harness} />
        <RailFact k="Model" v={config.model ?? "—"} />
        {owner ? <RailFact k="Owner" v={owner} /> : null}
        {agent.branch ? <RailFact k="Branch" v={agent.branch} mono /> : null}
        <RailFact k="State" v={agentStateLabel(agent.state)} />
        {agent.updatedAt ? <RailFact k="Updated" v={timeAgo(agent.updatedAt)} /> : null}
        <RailFact k="Sessions" v={String(entry.sessions.length)} />
      </div>

      {config.permission ? (
        <div className="ac-railSub">
          <div className="ac-railSubHead">Permissions</div>
          <span className="ac-chip">{config.permission}</span>
        </div>
      ) : null}

      {config.capabilities.length ? (
        <div className="ac-railSub">
          <div className="ac-railSubHead">Capabilities · {config.capabilities.length}</div>
          <div className="ac-chips">
            {config.capabilities.map((c) => (
              <span className="ac-chip" key={c}>
                {c}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {agent.conversationId && onOpenConversation ? (
        <button type="button" className="ac-railOpen" onClick={() => onOpenConversation(agent.id)}>
          Open conversation →
        </button>
      ) : null}
    </div>
  );
}

// ── small shared bits ───────────────────────────────────────────────────────

function MetaItem({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <span className="ac-metaItem">
      <span className="ac-metaKey">{k}</span>
      <span className="ac-metaVal" data-mono={mono || undefined}>
        {v}
      </span>
    </span>
  );
}

function ConfigRow({
  k,
  children,
  mono,
  title,
}: {
  k: string;
  children: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="ac-configRow">
      <span className="ac-configKey">{k}</span>
      <span className="ac-configVal" data-mono={mono || undefined} title={title}>
        {children}
      </span>
    </div>
  );
}

function RailFact({
  k,
  v,
  mono,
  mark,
}: {
  k: string;
  v: string;
  mono?: boolean;
  mark?: string | null;
}) {
  return (
    <div className="ac-railFact">
      <span className="ac-railFactKey">{k}</span>
      <span className="ac-railFactVal" data-mono={mono || undefined}>
        {mark ? (
          <span className="ac-inlineMark">
            <HarnessMark harness={mark} size={11} />
          </span>
        ) : null}
        {v}
      </span>
    </div>
  );
}
