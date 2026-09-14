/**
 * Reading one node's own workload out of an older peer's registry snapshot.
 *
 * Brokers that predate `/v1/mesh/node-state` serve one observe-tier route that
 * can answer "what is on you": the registry snapshot. It is the wrong shape for
 * the question — it ignores the `scope` hint and returns the peer's whole
 * registry, including its second-hand view of every other machine it has heard
 * of. Measured against the live fleet: 42 MB and 11,008 agent records to learn
 * about the 9 that actually live there; 7.6 MB and 2,179 for 12.
 *
 * So this does not buffer the response. It walks the body as it arrives,
 * parses one record at a time, keeps only what belongs to the node we asked
 * about, and drops everything else as it goes. Peak memory is one record plus
 * the bounded result, whatever the peer sends.
 *
 * This path runs on selection only, never on a poll. It reports which sections
 * it actually reached, so a section the scan never got to is shown as unread
 * rather than empty.
 */

export type PeerSnapshotAgent = {
  id: string;
  displayName?: string;
  handle?: string;
  homeNodeId?: string;
  authorityNodeId?: string;
  metadata?: Record<string, unknown>;
};

export type PeerSnapshotEndpoint = {
  id: string;
  agentId?: string;
  nodeId?: string;
  harness?: string;
  transport?: string;
  state?: string;
  sessionId?: string;
  lastSeenAt?: number;
  metadata?: Record<string, unknown>;
};

export type PeerSnapshotFlight = {
  id: string;
  state?: string;
  targetAgentId?: string;
  originAgentId?: string;
  kind?: string;
  startedAt?: number;
  completedAt?: number;
  /** Older shapes carry these instead; both are read for ranking. */
  createdAt?: number;
  updatedAt?: number;
};

export type PeerSnapshotSection = "agents" | "endpoints" | "flights";

export type PeerSnapshotProjection = {
  /** Agents homed on the requested node, capped. */
  agents: PeerSnapshotAgent[];
  /** Live sessions on that node, capped. */
  endpoints: PeerSnapshotEndpoint[];
  /** Work aimed at that node's agents, capped. */
  flights: PeerSnapshotFlight[];
  /** Totals matched before the caps, per section. */
  matched: Record<PeerSnapshotSection, number>;
  /** Records examined per section. */
  scanned: Record<PeerSnapshotSection, number>;
  /** Agent records the peer attributes elsewhere, or to no node at all. */
  unattributed: number;
  /** Records skipped because a single record exceeded the per-record bound. */
  oversizeRecords: number;
  bytesRead: number;
  /** Sections whose map we read from start to finish. */
  complete: PeerSnapshotSection[];
  /** We hit the byte ceiling first; every count above is partial. */
  truncated: boolean;
};

export type PeerSnapshotProjectionOptions = {
  /**
   * The node whose workload we are reading. Required: a peer's registry holds
   * its second-hand view of every machine it has heard of, so without a node to
   * scope to there is no honest answer — only someone else's roster relabelled
   * as this device.
   */
  nodeId: string;
  limit: number;
  /** Hard ceiling on bytes read from the peer before we give up. */
  maxBytes: number;
};

const WANTED: ReadonlySet<string> = new Set<PeerSnapshotSection>(["agents", "endpoints", "flights"]);
/** Keep the working buffer near one record rather than one response. */
const TRIM_THRESHOLD = 64 * 1024;
/**
 * One registry record is small. A record that keeps growing is a peer sending
 * something we did not ask for — an unclosed brace, or a megabyte of metadata
 * on a single agent — and it is dropped rather than buffered to the response
 * ceiling. Without this, four concurrent legacy reads can hold four times the
 * wire cap in memory.
 */
const MAX_RECORD_BYTES = 256 * 1024;
/**
 * Flights seen before the agents section are held until we know who is homed
 * here. The hold is bounded and ranked, so a peer that emits flights first
 * still gets its live work attributed without buffering the whole section.
 */
const PENDING_FLIGHT_MAX = 256;
const WORKING_FLIGHT_STATES = new Set(["queued", "waking", "running", "waiting"]);
const TERMINAL_ENDPOINT_STATES = new Set(["closed", "detached", "ended", "gone"]);

export async function projectPeerSnapshot(
  body: ReadableStream<Uint8Array> | null,
  options: PeerSnapshotProjectionOptions,
): Promise<PeerSnapshotProjection> {
  const result: PeerSnapshotProjection = {
    agents: [],
    endpoints: [],
    flights: [],
    matched: { agents: 0, endpoints: 0, flights: 0 },
    scanned: { agents: 0, endpoints: 0, flights: 0 },
    unattributed: 0,
    oversizeRecords: 0,
    bytesRead: 0,
    complete: [],
    truncated: false,
  };
  if (!body) return result;

  // Every agent homed here, not just the ones that fit the roster cap — work
  // is matched against this, so a flight aimed at agent 30 still counts.
  const ownAgentIds = new Set<string>();
  /** Flights read before we knew who lives here; resolved once agents land. */
  const pendingFlights: PeerSnapshotFlight[] = [];
  let agentsSectionDone = false;

  function takeAgent(raw: string): void {
    result.scanned.agents += 1;
    const record = parse<PeerSnapshotAgent>(raw);
    if (!record?.id) { result.unattributed += 1; return; }
    if ((record.homeNodeId ?? null) !== options.nodeId) { result.unattributed += 1; return; }
    ownAgentIds.add(record.id);
    result.matched.agents += 1;
    if (result.agents.length < options.limit) result.agents.push(record);
  }

  function takeEndpoint(raw: string): void {
    result.scanned.endpoints += 1;
    const record = parse<PeerSnapshotEndpoint>(raw);
    if (!record?.id) return;
    // An endpoint names its own node, so it is checked directly rather than
    // inferred from the agent it serves.
    if (record.nodeId !== options.nodeId) return;
    result.matched.endpoints += 1;
    keepRanked(result.endpoints, record, options.limit, endpointRank);
  }

  function takeFlight(raw: string): void {
    result.scanned.flights += 1;
    const record = parse<PeerSnapshotFlight>(raw);
    if (!record?.id || !record.targetAgentId) return;
    // Section order is the peer's choice. A flight read before the agents
    // section waits in a bounded, ranked hold rather than being dropped as
    // unattributable, which is what made "work: none" depend on key order.
    if (!agentsSectionDone) {
      keepRanked(pendingFlights, record, PENDING_FLIGHT_MAX, flightRank);
      return;
    }
    if (!ownAgentIds.has(record.targetAgentId)) return;
    result.matched.flights += 1;
    keepRanked(result.flights, record, options.limit, flightRank);
  }

  function drainPendingFlights(): void {
    for (const record of pendingFlights) {
      if (!record.targetAgentId || !ownAgentIds.has(record.targetAgentId)) continue;
      result.matched.flights += 1;
      keepRanked(result.flights, record, options.limit, flightRank);
    }
    pendingFlights.length = 0;
  }

  const take: Record<PeerSnapshotSection, (raw: string) => void> = {
    agents: takeAgent,
    endpoints: takeEndpoint,
    flights: takeFlight,
  };

  const reader = body.getReader();
  const decoder = new TextDecoder();

  let buf = "";
  let index = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString: string | null = null;
  let pendingKey: string | null = null;
  let section: PeerSnapshotSection | null = null;
  let sectionDepth = -1;
  let recordStart = -1;
  /** Inside a record we abandoned: consume to its close, keep nothing. */
  let skippingRecord = false;
  let finished = false;

  try {
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result.bytesRead += chunk.value.byteLength;
      if (result.bytesRead > options.maxBytes) { result.truncated = true; break; }
      buf += decoder.decode(chunk.value, { stream: true });

      while (index < buf.length) {
        const char = buf[index]!;

        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') {
            inString = false;
            lastString = buf.slice(stringStart + 1, index);
          }
          index += 1;
          continue;
        }

        if (char === '"') { inString = true; stringStart = index; index += 1; continue; }

        if (char === ":") { pendingKey = lastString; lastString = null; index += 1; continue; }

        if (char === "{" || char === "[") {
          if (skippingRecord) { depth += 1; pendingKey = null; index += 1; continue; }
          if (section === null && depth === 1 && char === "{" && pendingKey && WANTED.has(pendingKey)) {
            section = pendingKey as PeerSnapshotSection;
            sectionDepth = depth + 1;
          } else if (section !== null && depth === sectionDepth && recordStart === -1) {
            recordStart = index;
          }
          depth += 1;
          pendingKey = null;
          index += 1;
          continue;
        }

        if (char === "}" || char === "]") {
          depth -= 1;
          index += 1;
          if (section !== null && depth === sectionDepth && skippingRecord) {
            skippingRecord = false;
            buf = buf.slice(index);
            index = 0;
            continue;
          }
          if (section !== null && depth === sectionDepth && recordStart !== -1) {
            take[section](buf.slice(recordStart, index));
            recordStart = -1;
            buf = buf.slice(index);
            index = 0;
          } else if (section !== null && depth < sectionDepth) {
            result.complete.push(section);
            if (section === "agents") {
              agentsSectionDone = true;
              drainPendingFlights();
            }
            section = null;
            sectionDepth = -1;
            if (result.complete.length === WANTED.size) { finished = true; break; }
          } else if (depth === 0) {
            finished = true;
            break;
          }
          continue;
        }

        index += 1;
      }

      // Skipping a section we do not want still costs a scan, but it must not
      // cost memory: drop what is already behind us.
      if (recordStart === -1 && index > TRIM_THRESHOLD) {
        buf = buf.slice(index);
        index = 0;
      } else if (recordStart !== -1 && index - recordStart > MAX_RECORD_BYTES) {
        // One record has outgrown anything a registry record should be. Give up
        // on it — including its unparsed bytes — and resume at the scan head.
        result.oversizeRecords += 1;
        if (section) result.scanned[section] += 1;
        buf = buf.slice(index);
        index = 0;
        recordStart = -1;
        skippingRecord = true;
      }
    }
  } finally {
    // Stop the transfer as soon as we have what we came for; the rest of the
    // peer's registry is not ours to download.
    await reader.cancel().catch(() => undefined);
  }

  return result;
}

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Keep the best `limit` records seen so far, without holding the rest.
 *
 * A peer with 82 work records and room for 24 must not hand back the 24 that
 * happened to be serialized first: those are usually the oldest, so the list
 * fills with finished work while the running flights never appear.
 */
function keepRanked<T>(kept: T[], record: T, limit: number, rank: (item: T) => number): void {
  if (limit <= 0) return;
  if (kept.length < limit) {
    kept.push(record);
    kept.sort((a, b) => rank(b) - rank(a));
    return;
  }
  const worst = kept[kept.length - 1]!;
  if (rank(record) <= rank(worst)) return;
  kept[kept.length - 1] = record;
  kept.sort((a, b) => rank(b) - rank(a));
}

/** Live work outranks finished work; within each, the most recent first. */
function flightRank(flight: PeerSnapshotFlight): number {
  const when = Math.max(
    flight.completedAt ?? 0,
    flight.updatedAt ?? 0,
    flight.startedAt ?? 0,
    flight.createdAt ?? 0,
  );
  return (WORKING_FLIGHT_STATES.has(flight.state ?? "") ? 1e15 : 0) + when;
}

/** A session still attached outranks one that has ended. */
function endpointRank(endpoint: PeerSnapshotEndpoint): number {
  const when = endpoint.lastSeenAt ?? 0;
  const ended = TERMINAL_ENDPOINT_STATES.has(endpoint.state ?? "")
    || endpoint.metadata?.staleLocalRegistration === true;
  return (ended ? 0 : 1e15) + when;
}
