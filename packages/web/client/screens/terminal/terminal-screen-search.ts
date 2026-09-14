import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { TerminalListItem } from "../../lib/terminal-sessions.ts";

/**
 * Screens, fetched only when a query asks about them.
 *
 * What an operator remembers about a terminal is very often what it was
 * printing — the migration that failed, the test that hung — and none of that
 * is in the session record. The host can hand over a pane's visible text, so
 * `screen:` / `output:` queries capture and match it.
 *
 * It is opt-in per query, and never speculative, because a capture is a command
 * run against every live session on the host. A search that peeked on every
 * keystroke would put a burst of `capture-pane` calls behind each letter typed.
 */

/** Screens are held this long before a repeat search re-captures them. */
const SCREEN_TTL_MS = 20_000;
/** How much of the scrollback a capture asks for. */
const SCREEN_LINES = 200;
/** Upper bound on captures per search, newest sessions first. */
export const TERMINAL_SCREEN_CAPTURE_LIMIT = 24;
/** Captures in flight at once — enough to be quick, few enough to stay polite. */
const CONCURRENCY = 4;

type CachedScreen = { body: string; at: number };

const cache = new Map<string, CachedScreen>();

async function captureScreen(item: TerminalListItem): Promise<string | null> {
  const params = new URLSearchParams({
    backend: item.surface.backend,
    sessionName: item.surface.sessionName,
    lines: String(SCREEN_LINES),
  });
  if (item.surface.paneId) params.set("paneId", item.surface.paneId);
  try {
    const payload = await api<{ available: boolean; body?: string }>(
      `/api/terminal-sessions/peek?${params.toString()}`,
    );
    return payload.available && payload.body ? payload.body : null;
  } catch {
    // A host that cannot capture is not an error worth surfacing mid-search;
    // its sessions simply do not match a screen query.
    return null;
  }
}

/** Run `work` over `items`, a few at a time, stopping early if asked. */
async function inBatches<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  cancelled: () => boolean,
): Promise<void> {
  let index = 0;
  const runner = async () => {
    while (index < items.length && !cancelled()) {
      const next = items[index++]!;
      await work(next);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
}

export type TerminalScreenIndex = {
  /** Captured screens by list-item id. Absent means "not captured". */
  screens: Map<string, string>;
  capturing: boolean;
};

/**
 * Capture the visible text of `items` while `enabled`, cached briefly so that
 * refining a query does not re-run every capture. Returns what has arrived so
 * far, so results fill in rather than blocking on the slowest host.
 */
export function useTerminalScreens(
  items: readonly TerminalListItem[],
  enabled: boolean,
): TerminalScreenIndex {
  const [screens, setScreens] = useState<Map<string, string>>(new Map());
  const [capturing, setCapturing] = useState(false);
  // Identity of the set being captured, so re-renders with an equal list do not
  // restart the sweep.
  const signature = items.map((item) => item.id).join("|");
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setCapturing(false);
      return;
    }
    const run = ++latest.current;
    const cancelled = () => latest.current !== run;
    const targets = [...items]
      .sort((left, right) => (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0))
      .slice(0, TERMINAL_SCREEN_CAPTURE_LIMIT);

    const now = Date.now();
    const seeded = new Map<string, string>();
    const stale: TerminalListItem[] = [];
    for (const item of targets) {
      const hit = cache.get(item.id);
      if (hit && now - hit.at < SCREEN_TTL_MS) seeded.set(item.id, hit.body);
      else stale.push(item);
    }
    setScreens(seeded);
    if (stale.length === 0) {
      setCapturing(false);
      return;
    }

    setCapturing(true);
    void inBatches(stale, async (item) => {
      const body = await captureScreen(item);
      if (cancelled()) return;
      if (body === null) return;
      cache.set(item.id, { body, at: Date.now() });
      setScreens((current) => new Map(current).set(item.id, body));
    }, cancelled).finally(() => {
      if (!cancelled()) setCapturing(false);
    });

    return () => { latest.current += 1; };
    // `signature` stands in for the item list; `items` itself is a fresh array
    // on every render and would restart the sweep forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature]);

  return { screens, capturing };
}
