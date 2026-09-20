import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { VoiceUsageSnapshot } from "../../../shared/voice-usage.ts";

export function usageDuration(ms: number | null): string {
  if (ms === null) return "Unavailable";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function tokens(value: number | null | undefined): string {
  return value == null ? "Unavailable" : value.toLocaleString();
}

export function VoiceUsagePanel({ mode, active = false, currentLeaseId }: { mode: "local" | "api"; active?: boolean; currentLeaseId?: string | null }) {
  const [snapshot, setSnapshot] = useState<VoiceUsageSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const result = await api<VoiceUsageSnapshot>("/api/voice/usage", { signal: controller.signal });
        if (!controller.signal.aborted) { setSnapshot(result); setError(false); }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [mode, active, retry]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const summary = snapshot?.llm?.summaries.find(item => item.mode === mode);
  const records = snapshot?.llm?.records.filter(item => item.mode === mode) ?? [];
  const calls = mode === "api" ? snapshot?.calls ?? [] : [];
  return (
    <details className="border-t border-[var(--scout-chrome-border-soft)] px-4 py-3 text-xs leading-5 text-[var(--scout-chrome-ink-faint)]">
      <summary className="cursor-pointer font-medium text-[var(--scout-chrome-ink-strong)]">
        Usage · {error ? "Unable to refresh" : !snapshot ? "Loading…" : !snapshot.llm ? "LLM tracking unavailable" : `${summary?.requests ?? 0} provider ${summary?.requests === 1 ? "request" : "requests"} · ${tokens(summary?.totalTokens)} reported tokens`}
      </summary>
      {error && <p role="status" className="mt-2">Usage could not refresh. {snapshot ? "The measurements below may be out of date. " : ""}<button type="button" onClick={() => setRetry(value => value + 1)} className="underline">Retry</button></p>}
      {snapshot && (
        <div className="mt-3 space-y-3">
          <p>Recorded on this host since tracking began. Each provider attempt is a request; fallback attempts are listed separately, not counted again as a reply. Models shown are the requested models. These measurements are not a bill; TTS usage and dollar costs are not included.</p>
          <dl className="flex flex-wrap gap-x-6 gap-y-2">
            <div><dt>LLM input tokens</dt><dd className="font-medium text-[var(--scout-chrome-ink-strong)]">{tokens(summary?.inputTokens)}</dd></div>
            <div><dt>LLM output tokens</dt><dd className="font-medium text-[var(--scout-chrome-ink-strong)]">{tokens(summary?.outputTokens)}</dd></div>
            <div><dt>LLM request time</dt><dd className="font-medium text-[var(--scout-chrome-ink-strong)]">{usageDuration(summary?.elapsedMs ?? null)}</dd></div>
          </dl>
          {(summary?.missingTokenReports ?? 0) > 0 && <p>{summary!.missingTokenReports} {summary!.missingTokenReports === 1 ? "request has" : "requests have"} no total-token receipt. Reported totals are partial; unavailable counts are not zero.</p>}
          {records.length > 0 && <div>
            <h3 className="font-medium text-[var(--scout-chrome-ink-strong)]">Recent LLM provider requests</h3>
            <ul className="mt-1 max-h-44 space-y-2 overflow-y-auto">
              {records.map(record => <li key={record.id} className="break-words">
                <span className="text-[var(--scout-chrome-ink-strong)]">{record.model}</span> · {record.provider ?? "Provider not reported"} · {record.state === "pending" ? "No completion receipt yet" : record.state} · {usageDuration(record.elapsedMs)} · {tokens(record.totalTokens)} tokens
                <div className="text-[11px]">{new Date(record.startedAt).toLocaleString()} · Session {record.sessionId}</div>
              </li>)}
            </ul>
          </div>}
          {mode === "api" && <div>
            <h3 className="font-medium text-[var(--scout-chrome-ink-strong)]">Recent Live API calls</h3>
            <p>Audio duration is measured separately from LLM tokens. Unconfirmed calls may still have provider usage.</p>
            {calls.length === 0 ? <p>No recorded API calls.</p> : <ul className="mt-2 max-h-44 space-y-3 overflow-y-auto">
              {calls.map(call => <li key={call.leaseId} className="break-words">
                <span className="text-[var(--scout-chrome-ink-strong)]">{call.model ?? "Model not recorded"}</span> · {call.voice ?? "Voice not recorded"} · {call.state === "confirmed" ? "Provider closed" : call.state}
                <div>Provider duration: {call.providerSeconds === null ? "Unavailable" : `${call.providerSeconds}s`}</div>
                {call.clientReportedSeconds !== null && call.providerSeconds === null && <div>Client-reported provider duration: {call.clientReportedSeconds}s · server confirmation unavailable</div>}
                <div>Observed elapsed: {usageDuration(call.startedAt === null ? null : call.endedAt !== null ? call.endedAt - call.startedAt : active && call.leaseId === currentLeaseId && call.state === "active" ? now - call.startedAt : null)} · Session {call.sessionId}</div>
              </li>)}
            </ul>}
          </div>}
        </div>
      )}
    </details>
  );
}
