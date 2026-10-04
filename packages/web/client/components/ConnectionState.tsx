import { LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./connection-state.css";

export type ConnectionNotice = {
  kind: "loading" | "error" | "disconnected";
  title: string;
  detail: string;
  diagnostics?: string | null;
};

export type ConnectionTrace = { at: number; message: string };

export function useConnectionTraceLog() {
  const [trace, setTrace] = useState<ConnectionTrace[]>([]);
  const append = useCallback((message: string) => {
    setTrace((current) => current.at(-1)?.message === message ? current
      : [...current.slice(-23), { at: Date.now(), message }]);
  }, []);
  return { trace, append };
}

/** Only observed transitions enter the log; elapsed time never invents progress. */
export function useConnectionTrace(message: string): ConnectionTrace[] {
  const [trace, setTrace] = useState<ConnectionTrace[]>([]);
  useEffect(() => {
    if (!message) return;
    setTrace((current) => current.at(-1)?.message === message
      ? current
      : [...current.slice(-23), { at: Date.now(), message }]);
  }, [message]);
  return trace;
}

export function ConnectionState({ notice, trace = [], onRetry, compact = false }: {
  notice: ConnectionNotice;
  trace?: readonly ConnectionTrace[];
  onRetry?: () => void;
  compact?: boolean;
}) {
  const loading = notice.kind === "loading";
  return (
    <section className={`s-connection-state${compact ? " s-connection-state--compact" : ""}`} data-state={notice.kind}>
      <div className="s-connection-state-message" role="status" aria-live="polite" aria-atomic="true">
        <span className="s-connection-state-mark" aria-hidden="true">
          {loading ? <LoaderCircle size={22} strokeWidth={1.5} /> : <Unplug size={22} strokeWidth={1.5} />}
        </span>
        <h2>{notice.title}</h2>
        <p>{notice.detail}</p>
      </div>
      {!loading && onRetry && (
        <button type="button" className="s-connection-state-retry" onClick={onRetry}>
          <RefreshCw size={13} aria-hidden="true" /> Try again
        </button>
      )}
      {!loading && notice.diagnostics && (
        <details className="s-connection-state-details">
          <summary>Technical details</summary>
          <pre>{notice.diagnostics}</pre>
        </details>
      )}
      {trace.length > 0 && (loading ? <ConnectionTraceLog trace={trace} /> : (
        <details className="s-connection-trace-disclosure">
          <summary>Connection trace</summary>
          <ConnectionTraceLog trace={trace} live={false} />
        </details>
      ))}
    </section>
  );
}

export function ConnectionTraceLog({ trace, live = true, label = "Connection trace" }: {
  trace: readonly ConnectionTrace[];
  live?: boolean;
  label?: string;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [trace]);
  return (
        <div className="s-connection-trace" aria-label={label}>
          <div className="s-connection-trace-title">{label} <span>{live ? "Live" : "Latest attempt"}</span></div>
          <div ref={logRef} className="s-connection-trace-lines" role="log" aria-live="off" tabIndex={0} aria-label="Connection events">
            {trace.map((entry, index) => (
              <div className="s-connection-trace-line" key={`${entry.at}:${index}`}>
                <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString([], { hour12: false })}</time>
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
  );
}
