import type { ReactNode } from "react";
import type { Agent } from "../../lib/types.ts";

function shortCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.startsWith("/Users/")
    ? "~/" + cwd.split("/").slice(3).join("/")
    : cwd;
}

export type AgentEssentials = {
  cwdShort: string | null;
  hostShort: string | null;
  branch: string | null;
  chip: string | null;
  cwdFull: string | null;
};

export function agentEssentials(
  agent: Agent,
  opts?: { projectRoot?: string | null },
): AgentEssentials {
  const modelShort =
    agent.model && agent.harness && agent.model.startsWith(`${agent.harness}-`)
      ? agent.model.slice(agent.harness.length + 1)
      : agent.model ?? null;
  const cwdFull = agent.cwd ?? agent.projectRoot ?? opts?.projectRoot ?? null;
  const cwdShort = cwdFull ? (shortCwd(cwdFull) ?? cwdFull) : null;
  const hostShort = agent.homeNodeName
    ? agent.homeNodeName.replace(/\.local$/i, "")
    : null;
  const chip =
    [agent.harness, modelShort]
      .filter((v): v is string => Boolean(v))
      .join(" · ") || null;
  const branch = agent.branch?.trim() || null;

  return { cwdShort, hostShort, branch, chip, cwdFull };
}

function IcoFolder() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <path d="M2 4h4l1.4 1.6H14v6.4H2z" strokeLinejoin="round" />
    </svg>
  );
}
function IcoBranch() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M4.5 11c0-3 7-1.4 7-4" strokeLinecap="round" />
    </svg>
  );
}
function IcoChip() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2" strokeLinecap="round" />
    </svg>
  );
}
function IcoHost() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <rect x="2.5" y="3.5" width="11" height="7" rx="1" />
      <path d="M6 13h4M8 10.5V13" strokeLinecap="round" />
    </svg>
  );
}

function EssentialCell({ ico, v, title }: { ico: ReactNode; v: string; title?: string }) {
  return (
    <span className="s-sess-glyph-cell" title={title ?? v}>
      <span className="s-sess-glyph-ico">{ico}</span>
      <span className="s-sess-glyph-v">{v}</span>
    </span>
  );
}

/** 2×2 glyph grid: path · branch / host · harness·model — no word labels. */
export function AgentEssentialsGlyph({
  agent,
  projectRoot,
  chipTitle,
  className,
}: {
  agent: Agent;
  projectRoot?: string | null;
  chipTitle?: string | null;
  className?: string;
}) {
  const { cwdShort, hostShort, branch, chip, cwdFull } = agentEssentials(agent, { projectRoot });
  const hasEssentials = Boolean(cwdShort || branch || hostShort || chip);
  if (!hasEssentials) return null;

  return (
    <div
      className={["s-sess-glyph", className].filter(Boolean).join(" ")}
      aria-label="Agent runtime essentials"
    >
      {cwdShort && <EssentialCell ico={<IcoFolder />} v={cwdShort} title={cwdFull ?? cwdShort} />}
      {branch && <EssentialCell ico={<IcoBranch />} v={branch} />}
      {hostShort && <EssentialCell ico={<IcoHost />} v={hostShort} />}
      {chip && <EssentialCell ico={<IcoChip />} v={chip} title={chipTitle ?? chip} />}
    </div>
  );
}