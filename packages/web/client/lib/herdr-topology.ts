import { useEffect, useState } from "react";

import type { HerdrSessionTopology } from "@openscout/protocol";

import { api } from "./api.ts";

/**
 * Read-only projection of a herdr session's workspace/tab/pane topology. Herdr
 * owns the layout; this hook exists so the terminals view can REPRESENT a
 * session faithfully — agent status is the fast-moving part, so polling is on
 * a few-second cadence and pauses while the tab is hidden.
 */

export async function fetchHerdrTopology(sessionName: string): Promise<HerdrSessionTopology> {
  const payload = await api<{ ok: boolean; topology: HerdrSessionTopology }>(
    `/api/terminal-hosts/herdr/sessions/${encodeURIComponent(sessionName)}/topology`,
  );
  return payload.topology;
}

/** Focus a pane/agent in the native herdr client — a handoff, not a control. */
export async function focusHerdrPane(sessionName: string, target: string): Promise<void> {
  await api<{ ok: boolean }>(
    `/api/terminal-hosts/herdr/sessions/${encodeURIComponent(sessionName)}/focus`,
    { method: "POST", body: JSON.stringify({ target }) },
  );
}

/** One snapshot of a herdr pane's visible content, via the shared peek route. */
export async function fetchHerdrPanePeek(
  sessionName: string,
  paneId: string,
  lines = 48,
): Promise<{ body: string | null; reason: string | null }> {
  const params = new URLSearchParams({
    backend: "herdr",
    sessionName,
    paneId,
    lines: String(lines),
  });
  const payload = await api<{ available: boolean; body: string; reason?: string }>(
    `/api/terminal-sessions/peek?${params.toString()}`,
  );
  return payload.available
    ? { body: payload.body, reason: null }
    : { body: null, reason: payload.reason ?? "No preview available." };
}

const HERDR_PEEK_POLL_MS = 3_000;

/**
 * The dive-in view's content feed: the pane's visible text on a few-second
 * cadence, pausing while the tab is hidden. A failed poll keeps the last good
 * content and only replaces it when a reason is all there has ever been — a
 * blink in the herdr server should not blank the view.
 */
export function useHerdrPanePeek(
  sessionName: string | null,
  paneId: string | null,
  options: { lines?: number; pollMs?: number; enabled?: boolean } = {},
): { body: string | null; reason: string | null; loading: boolean; refresh: () => void } {
  const enabled = options.enabled ?? true;
  const lines = options.lines ?? 48;
  const pollMs = options.pollMs ?? HERDR_PEEK_POLL_MS;
  const [snapshot, setSnapshot] = useState<{ body: string | null; reason: string | null } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionName || !paneId || !enabled) return;
    let cancelled = false;
    setSnapshot(null);

    const load = () => {
      void fetchHerdrPanePeek(sessionName, paneId, lines)
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch((cause) => {
          if (cancelled) return;
          const reason = cause instanceof Error ? cause.message : String(cause);
          setSnapshot((current) => ({ body: current?.body ?? null, reason }));
        });
    };

    load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionName, paneId, lines, enabled, pollMs, tick]);

  return {
    body: snapshot?.body ?? null,
    reason: snapshot?.reason ?? null,
    loading: snapshot === null,
    refresh: () => setTick((value) => value + 1),
  };
}

const HERDR_PANE_OUTPUTS_POLL_MS = 15_000;

/**
 * The pane table's output column: the last few visible lines of each pane in
 * the list, on a slow cadence. One peek per pane per tick, batched; a failed
 * pane keeps its last good body, and polling pauses while the tab is hidden —
 * the same posture as the dive-in peek, at a tenth of its rate.
 */
export function useHerdrPaneOutputs(
  sessionName: string | null,
  paneIds: readonly string[],
  options: { lines?: number; pollMs?: number; enabled?: boolean } = {},
): Record<string, string | null> {
  const enabled = options.enabled ?? true;
  const lines = options.lines ?? 6;
  const pollMs = options.pollMs ?? HERDR_PANE_OUTPUTS_POLL_MS;
  const [bodies, setBodies] = useState<Record<string, string | null>>({});
  const key = paneIds.join("\n");

  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    if (!sessionName || !enabled || ids.length === 0) return;
    let cancelled = false;

    const load = () => {
      void Promise.all(ids.map(async (paneId) => {
        try {
          const next = await fetchHerdrPanePeek(sessionName, paneId, lines);
          return [paneId, next.body] as const;
        } catch {
          return [paneId, undefined] as const;
        }
      })).then((entries) => {
        if (cancelled) return;
        setBodies((current) => {
          const next: Record<string, string | null> = {};
          for (const [paneId, body] of entries) {
            next[paneId] = body === undefined ? (current[paneId] ?? null) : body;
          }
          return next;
        });
      });
    };

    load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionName, key, lines, enabled, pollMs]);

  return bodies;
}

const HERDR_TOPOLOGY_POLL_MS = 3_000;

export function useHerdrTopology(
  sessionName: string | null,
  options: { pollMs?: number; enabled?: boolean } = {},
): { topology: HerdrSessionTopology | null; error: string | null; refresh: () => void } {
  const enabled = options.enabled ?? true;
  const pollMs = options.pollMs ?? HERDR_TOPOLOGY_POLL_MS;
  const [topology, setTopology] = useState<HerdrSessionTopology | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionName || !enabled) return;
    let cancelled = false;

    const load = () => {
      void fetchHerdrTopology(sessionName)
        .then((next) => {
          if (cancelled) return;
          setTopology(next);
          setError(null);
        })
        .catch((cause) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    };

    load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionName, enabled, pollMs, tick]);

  return {
    topology,
    error,
    refresh: () => setTick((value) => value + 1),
  };
}
