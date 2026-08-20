import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { agentStateLabel } from "../../lib/agent-state.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { timeAgo } from "../../lib/time.ts";
import { formatLabel } from "../../lib/text.ts";
import type { Agent, Route, TerminalSurfaceDescriptor } from "../../lib/types.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import {
  fetchTerminalSessions,
  resolveRegisteredTerminalTarget,
  terminalSurfaceDescriptorFromRegisteredSurface,
  type RegisteredTerminalTarget,
} from "../../lib/terminal-sessions.ts";

export function TerminalInspector() {
  const { route, agents, navigate } = useScout();
  if (route.view !== "terminal") return null;

  const agent = route.agentId
    ? agents.find((candidate) => candidate.id === route.agentId) ?? null
    : null;
  const mode = route.mode ?? "takeover";
  const [registeredTarget, setRegisteredTarget] = useState<RegisteredTerminalTarget | null>(null);

  useEffect(() => {
    if (route.view !== "terminal" || route.agentId || !route.terminalSurfaceKey) {
      setRegisteredTarget(null);
      return;
    }
    let cancelled = false;
    void fetchTerminalSessions()
      .then((sessions) => {
        if (cancelled) return;
        setRegisteredTarget(resolveRegisteredTerminalTarget(
          sessions,
          route.terminalSessionId,
          route.terminalSurfaceKey,
        ));
      })
      .catch(() => {
        if (!cancelled) setRegisteredTarget(null);
      });
    return () => {
      cancelled = true;
    };
  }, [route.agentId, route.terminalSessionId, route.terminalSurfaceKey, route.view]);

  const registeredSurface = registeredTarget
    ? terminalSurfaceDescriptorFromRegisteredSurface(registeredTarget.surface)
    : null;
  const agentSurface = agent ? agentTerminalSurface(agent) : null;
  const terminalSurface = agentSurface ?? registeredSurface;
  const attachCommand = useMemo(
    () => terminalSurface ? terminalAttachCommand(terminalSurface) : null,
    [terminalSurface],
  );

  if (!agent) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm frame-scrollbar">
        <Section label="Terminal">
          <Row label="Mode" value={modeLabel(mode)} />
          {route.agentId && <Row label="Agent" value={route.agentId} />}
          {terminalSurface && <Row label="Backend" value={terminalSurface.backend} />}
          {terminalSurface && <Row label="Session" value={terminalSurface.sessionName} />}
        </Section>
        {attachCommand && <CommandDisclosure label="Open in your own terminal" command={attachCommand} />}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm frame-scrollbar">
      <AgentHeader agent={agent} />

      <Section label="Terminal">
        <Row label="Mode" value={modeLabel(mode)} />
        <Row label="Backend" value={terminalSurface?.backend ?? "pty"} />
        {terminalSurface && <Row label="Session" value={terminalSurface.sessionName} />}
        {terminalSurface?.paneId && <Row label="Pane" value={terminalSurface.paneId} />}
        <Row label="State" value={agentStateLabel(agent.state)} />
      </Section>

      {attachCommand && <CommandDisclosure label="Open in your own terminal" command={attachCommand} />}

      <div className="grid grid-cols-2 gap-1.5">
        {terminalSurface && (
          <ModeButton
            active={mode === "observe"}
            label="Observe"
            onClick={() => navigate(terminalRoute(agent.id, "observe"))}
          />
        )}
        <ModeButton
          active={mode === "takeover"}
          label="Takeover"
          onClick={() => navigate(terminalRoute(agent.id, "takeover"))}
        />
        <ModeButton
          label="Profile"
          onClick={() => navigate({ view: "agents-v2", agentId: agent.id, tab: "profile" })}
        />
        <ModeButton
          label="Trace"
          onClick={() => navigate({ view: "agents-v2", agentId: agent.id, tab: "observe" })}
        />
      </div>

      <Section label="Agent">
        <Row label="Harness" value={agent.harness ?? "-"} />
        <Row label="Transport" value={agent.transport ?? "-"} />
        {agent.role && <Row label="Role" value={formatLabel(agent.role) ?? agent.role} />}
        {agent.handle && <Row label="Handle" value={`@${agent.handle}`} />}
        {agent.updatedAt && <Row label="Updated" value={timeAgo(agent.updatedAt)} />}
      </Section>

      {(agent.project || agent.branch || agent.cwd || agent.projectRoot) && (
        <Section label="Workspace">
          {agent.project && <Row label="Name" value={agent.project} />}
          {agent.branch && <Row label="Branch" value={agent.branch} />}
          {agent.cwd && <Row label="Cwd" value={agent.cwd} />}
          {!agent.cwd && agent.projectRoot && <Row label="Root" value={agent.projectRoot} />}
        </Section>
      )}
    </div>
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function terminalAttachCommand(surface: TerminalSurfaceDescriptor): string {
  if (surface.backend === "tmux") {
    return `tmux attach -t ${shellQuote(surface.sessionName)}`;
  }
  const socketPrefix = surface.socketDir
    ? `ZELLIJ_SOCKET_DIR=${shellQuote(surface.socketDir)} `
    : "";
  return `${socketPrefix}zellij attach ${shellQuote(surface.sessionName)}`;
}

function terminalRoute(agentId: string, mode: "observe" | "takeover"): Route {
  return { view: "terminal", agentId, mode };
}

function agentTerminalSurface(agent: Agent): TerminalSurfaceDescriptor | null {
  if (agent.terminalSurface) return agent.terminalSurface;
  if (agent.transport === "tmux" && agent.harnessSessionId) {
    return {
      backend: "tmux",
      sessionName: agent.harnessSessionId,
      paneId: null,
      socketDir: null,
    };
  }
  return null;
}

function modeLabel(mode: "observe" | "takeover"): string {
  return mode === "observe" ? "Read-only observe" : "Interactive takeover";
}

function AgentHeader({ agent }: { agent: Agent }) {
  return (
    <div className="border-b border-[var(--scout-chrome-border-soft)] pb-3">
      <div className="flex items-center gap-2.5">
        <AgentAvatar agent={agent} placement="row" size={32} presence={false} />
        <div className="min-w-0">
          <div className="truncate text-lg leading-snug text-[var(--scout-chrome-ink-strong)]">
            {agent.name}
          </div>
          {agent.handle && (
            <div className="truncate font-mono text-xs text-cyan-400/70">
              @{agent.handle}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  label,
  onClick,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 rounded border px-2 font-mono text-2xs uppercase tracking-[0.1em] transition-colors ${
        active
          ? "border-cyan-400/35 bg-cyan-400/[0.12] text-cyan-200"
          : "border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] text-[var(--scout-chrome-ink-soft)] hover:bg-[var(--scout-chrome-active)] hover:text-[var(--scout-chrome-ink)]"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * The raw multiplexer invocation, behind a disclosure.
 *
 * It used to lead the inspector under the label "Attach command", which taught
 * every operator that Scout is a tmux wrapper. Scout manages the multiplexer;
 * the argv is an escape hatch for the operator who wants their own terminal,
 * and it is labelled by what it does rather than by which tool it drives.
 */
function CommandDisclosure({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] p-2">
      <summary className="cursor-pointer select-none font-mono text-2xs uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </summary>
      <div className="mb-1.5 mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded border border-cyan-400/20 bg-cyan-400/[0.08] px-2 py-1 font-mono text-2xs uppercase tracking-[0.1em] text-cyan-100/80 hover:bg-cyan-400/[0.14]"
          onClick={() => {
            void copyTextToClipboard(command).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code className="block select-text break-all rounded bg-black/25 p-2 font-mono text-xs leading-relaxed text-[var(--scout-chrome-ink)]">
        {command}
      </code>
    </details>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="mb-1.5 text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-xs font-mono uppercase tracking-wider text-[var(--scout-chrome-ink-faint)]">
        {label}
      </span>
      <span className="truncate text-right text-sm font-mono text-[var(--scout-chrome-ink)]">
        {value}
      </span>
    </div>
  );
}
