import { useEffect, useRef, useState } from "react";

import { fetchHerdrTopology } from "../../lib/herdr-topology.ts";
import type { TerminalListItem } from "../../lib/terminal-sessions.ts";
import { herdrPaneSearchText } from "./terminal-pane-text.ts";

/**
 * What is inside a session, fetched only when a query asks about it.
 *
 * A multiplexer session is one row in the list and a dozen places to be. The
 * row carries the session's name, which is the one name an operator does not
 * need help with — what they are actually looking for is the pane: "where is
 * vera sitting", "which desk has the migration open". Herdr already names each
 * of those, in the pane's own title; this reads them so `pane:` can match.
 *
 * It is opt-in per query for the same reason screens are: a read is a command
 * per session against the herdr server, and searching on every keystroke would
 * put a burst of them behind each letter typed.
 *
 * Only herdr answers here. tmux and zellij have panes too, but Scout has no
 * topology projection for them — a `pane:` query simply does not match their
 * rows, rather than matching them on something weaker and pretending.
 */

/** A read is held this long before a repeat search asks the host again. */
const PANES_TTL_MS = 20_000;
/** Upper bound on sessions read per search, newest first. */
export const TERMINAL_PANE_READ_LIMIT = 12;
/** Reads in flight at once. */
const CONCURRENCY = 3;

type CachedPanes = { body: string; at: number };

const cache = new Map<string, CachedPanes>();

async function readPanes(item: TerminalListItem): Promise<string | null> {
  try {
    const topology = await fetchHerdrTopology(item.surface.sessionName);
    const body = herdrPaneSearchText(topology);
    return body.length > 0 ? body : null;
  } catch {
    // A host that cannot be read mid-search is not an error worth surfacing;
    // its session simply does not match a pane query.
    return null;
  }
}

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

export type TerminalPaneIndex = {
  /** Pane text by list-item id. Absent means "not read". */
  panes: Map<string, string>;
  reading: boolean;
};

/** The rows a `pane:` query can be answered for at all. */
export function terminalPaneReadableItems(
  items: readonly TerminalListItem[],
): TerminalListItem[] {
  return items.filter((item) => item.surface.backend === "herdr");
}

/**
 * Read the panes of `items` while `enabled`, cached briefly so that refining a
 * query does not re-read every session. Returns what has arrived so far, so
 * results fill in rather than blocking on the slowest host.
 */
export function useTerminalPanes(
  items: readonly TerminalListItem[],
  enabled: boolean,
): TerminalPaneIndex {
  const [panes, setPanes] = useState<Map<string, string>>(new Map());
  const [reading, setReading] = useState(false);
  const signature = items.map((item) => item.id).join("|");
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setReading(false);
      return;
    }
    const run = ++latest.current;
    const cancelled = () => latest.current !== run;
    const targets = [...items]
      .sort((left, right) => (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0))
      .slice(0, TERMINAL_PANE_READ_LIMIT);

    const now = Date.now();
    const seeded = new Map<string, string>();
    const stale: TerminalListItem[] = [];
    for (const item of targets) {
      const hit = cache.get(item.id);
      if (hit && now - hit.at < PANES_TTL_MS) seeded.set(item.id, hit.body);
      else stale.push(item);
    }
    setPanes(seeded);
    if (stale.length === 0) {
      setReading(false);
      return;
    }

    setReading(true);
    void inBatches(stale, async (item) => {
      const body = await readPanes(item);
      if (cancelled()) return;
      if (body === null) return;
      cache.set(item.id, { body, at: Date.now() });
      setPanes((current) => new Map(current).set(item.id, body));
    }, cancelled).finally(() => {
      if (!cancelled()) setReading(false);
    });

    return () => { latest.current += 1; };
    // `signature` stands in for the item list; `items` itself is a fresh array
    // on every render and would restart the sweep forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature]);

  return { panes, reading };
}
