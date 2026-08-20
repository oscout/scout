import { useCallback, useEffect, useMemo, useState } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { timeAgo } from "../../lib/time.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import type {
  Route,
  SessionEntry,
  TailDiscoveredTranscript,
  TailDiscoverySnapshot,
} from "../../lib/types.ts";

function pathLeaf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizeSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = pathLeaf(trimmed);
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function sessionProjectLabel(session: SessionEntry): string {
  return session.workspaceRoot ? pathLeaf(session.workspaceRoot) : session.agentName ?? "unassigned";
}

function sessionSourceLabel(session: SessionEntry): string {
  return session.harness?.trim() || session.kind?.trim() || "scout";
}

function transcriptProjectLabel(transcript: TailDiscoveredTranscript): string {
  return transcript.project?.trim()
    || (transcript.cwd ? pathLeaf(transcript.cwd) : null)
    || "unknown";
}

function topCounts(values: string[], limit = 4): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value.trim() || "unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit);
}

export function SessionsInspector() {
  const { route, navigate } = useScout();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);

  const load = useCallback(async () => {
    const [sessionsResult, discoveryResult] = await Promise.allSettled([
      api<SessionEntry[]>("/api/sessions"),
      api<TailDiscoverySnapshot>("/api/tail/discover"),
    ]);
    if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
    if (discoveryResult.status === "fulfilled") setDiscovery(discoveryResult.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  if (route.view !== "sessions") return null;

  const selected = route.sessionId
    ? sessions.find((s) => s.id === route.sessionId) ?? null
    : null;

  if (!selected) {
    return (
      <SessionsDirectoryContextPanel
        sessions={sessions}
        discovery={discovery}
        navigate={navigate}
        route={route}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
      <div className="border-b border-[var(--scout-chrome-border-soft)] pb-3">
        <div className="text-lg leading-snug text-[var(--scout-chrome-ink-strong)]">
          {selected.title}
        </div>
        <div className="text-xs font-mono uppercase tracking-wider text-cyan-400/70 mt-1">
          {selected.kind}
        </div>
      </div>

      {selected.agentName && (
        <Section label="Agent">
          <Row label="Name" value={selected.agentName} />
          {selected.harness && <Row label="Harness" value={selected.harness} />}
        </Section>
      )}

      {(selected.currentBranch || selected.workspaceRoot) && (
        <Section label="Workspace">
          {selected.currentBranch && (
            <Row label="Branch" value={selected.currentBranch} />
          )}
          {selected.workspaceRoot && (
            <Row label="Root" value={selected.workspaceRoot} />
          )}
        </Section>
      )}

      <Section label="Activity">
        <Row label="Messages" value={`${selected.messageCount}`} />
        {selected.lastMessageAt && (
          <Row label="Last" value={timeAgo(selected.lastMessageAt)} />
        )}
        {selected.participantIds.length > 0 && (
          <Row label="Participants" value={`${selected.participantIds.length}`} />
        )}
      </Section>

      {selected.preview && (
        <Section label="Preview">
          <div className="text-sm italic leading-relaxed text-[var(--scout-chrome-ink-soft)]">
            "{selected.preview}"
          </div>
        </Section>
      )}
    </div>
  );
}

function SessionsDirectoryContextPanel({
  sessions,
  discovery,
  navigate,
  route,
}: {
  sessions: SessionEntry[];
  discovery: TailDiscoverySnapshot | null;
  navigate: (r: Route) => void;
  route: Route;
}) {
  const transcripts = discovery?.transcripts ?? [];
  const sourceMix = useMemo(
    () => topCounts([
      ...sessions.map(sessionSourceLabel),
      ...transcripts.map((transcript) => transcript.source || "unknown"),
    ], 5),
    [sessions, transcripts],
  );
  const projectMix = useMemo(
    () => topCounts([
      ...sessions.map(sessionProjectLabel),
      ...transcripts.map(transcriptProjectLabel),
    ], 5),
    [sessions, transcripts],
  );
  const recentTranscripts = useMemo(
    () => transcripts
      .slice()
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 5),
    [transcripts],
  );
  const recentSessions = useMemo(
    () => sessions
      .filter((session) => session.lastMessageAt)
      .slice()
      .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
      .slice(0, 5),
    [sessions],
  );
  const liveProcesses = discovery?.processes?.length ?? 0;
  const totalRaw = discovery?.totals.transcripts ?? transcripts.length;
  const surfaceLabel = liveProcesses > 0 ? "Live harness activity" : "Quiet session surface";

  return (
    <div className="flex flex-col h-full overflow-y-auto frame-scrollbar p-4 gap-4 text-sm">
      <div className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] p-2.5">
        <div className="text-2xs font-mono uppercase tracking-[0.15em] text-[var(--scout-chrome-ink-faint)]">
          Sessions context
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1">
          <MiniStat label="Scout" value={`${sessions.length}`} />
          <MiniStat label="Raw" value={`${totalRaw}`} />
          <MiniStat label="Live" value={`${liveProcesses}`} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--scout-chrome-border-soft)] pt-2 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
          <span>{surfaceLabel}</span>
          <span>{sourceMix.length} sources</span>
        </div>
      </div>

      <Section label="Sources">
        <PillList items={sourceMix} empty="No sources visible" />
      </Section>

      <Section label="Project mix">
        <PillList items={projectMix} empty="No projects visible" />
      </Section>

      <Section label="Recent raw">
        {recentTranscripts.length === 0 ? (
          <EmptyLine>No raw transcripts discovered.</EmptyLine>
        ) : (
          <div className="flex flex-col gap-1.5">
            {recentTranscripts.map((transcript) => {
              const refId = normalizeSessionRef(transcript.sessionId)
                ?? normalizeSessionRef(transcript.transcriptPath);
              return (
                <button
                  key={`${transcript.source}:${transcript.transcriptPath}`}
                  type="button"
                  className="rounded border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] px-2 py-1.5 text-left transition-colors hover:border-[var(--scout-chrome-border)]"
                  onClick={() => {
                    if (refId) openContent(navigate, { view: "sessions", sessionId: refId }, { returnTo: route });
                  }}
                  disabled={!refId}
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded-sm bg-[var(--scout-chrome-bg)] px-1 py-0.5 font-mono text-3xs uppercase tracking-[0.08em] text-[var(--scout-chrome-ink-faint)]">
                      {transcript.source || "raw"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--scout-chrome-ink)]">
                      {transcriptProjectLabel(transcript)}
                    </span>
                    <span className="shrink-0 font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">
                      {timeAgo(transcript.mtimeMs)}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-2xs text-[var(--scout-chrome-ink-ghost)]">
                    {refId ?? pathLeaf(transcript.transcriptPath)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <Section label="Recent Scout sessions">
        {recentSessions.length === 0 ? (
          <EmptyLine>No recent Scout session messages.</EmptyLine>
        ) : (
          <div className="flex flex-col gap-1">
            {recentSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="flex items-center gap-2 bg-transparent px-0 py-0.5 text-left"
                onClick={() => openContent(navigate, { view: "sessions", sessionId: session.id }, { returnTo: route })}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--scout-chrome-ink-soft)]">
                  {session.title}
                </span>
                <span className="shrink-0 font-mono text-2xs text-[var(--scout-chrome-ink-faint)]">
                  {session.lastMessageAt ? timeAgo(session.lastMessageAt) : "-"}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-sm border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-bg)] px-1.5 py-1">
      <div className="font-mono text-2xs uppercase tracking-[0.1em] text-[var(--scout-chrome-ink-faint)]">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-lg text-[var(--scout-chrome-ink-strong)]">
        {value}
      </div>
    </div>
  );
}

function PillList({
  items,
  empty,
}: {
  items: Array<{ label: string; count: number }>;
  empty: string;
}) {
  if (items.length === 0) return <EmptyLine>{empty}</EmptyLine>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item.label}
          className="rounded-sm border border-[var(--scout-chrome-border-soft)] bg-[var(--scout-chrome-hover)] px-1.5 py-0.5 font-mono text-xs text-[var(--scout-chrome-ink-soft)]"
          title={`${item.count} ${item.label}`}
        >
          {item.label} {item.count}
        </span>
      ))}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-mono uppercase tracking-[0.12em] text-[var(--scout-chrome-ink-ghost)]">
      {children}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
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
    <div className="flex items-baseline justify-between py-0.5 gap-2">
      <span className="shrink-0 text-xs font-mono uppercase tracking-wider text-[var(--scout-chrome-ink-faint)]">
        {label}
      </span>
      <span className="truncate text-sm font-mono text-[var(--scout-chrome-ink)]">
        {value}
      </span>
    </div>
  );
}
