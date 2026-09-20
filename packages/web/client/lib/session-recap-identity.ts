export type RecapLaneInput = {
  id: string;
  source: "scout" | "native";
  lastActiveAt: number;
  agent: {
    id: string;
    name: string;
    handle: string | null;
    harness: string | null;
    harnessSessionId: string | null;
    homeNodeId: string | null;
    state: string | null;
  };
  observe: {
    metadata?: {
      session?: {
        adapterType?: string;
        source?: string;
        externalSessionId?: string;
        threadId?: string;
      };
    };
  } | null;
};

export type RecapTarget = {
  sessionRef: string;
  harness: string;
  voiceKey: string;
  displayLabel: string;
  identityVerified: boolean;
  sourceExact: string;
  observedAt: number | null;
  reportedState: string | null;
  nodeId: string | null;
};

function shortSession(sessionRef: string): string {
  const leaf = sessionRef.split(/[/:]/u).filter(Boolean).at(-1) ?? sessionRef;
  return leaf.replace(/^session[-_]?/i, "").slice(0, 8);
}

function observedHarness(lane: RecapLaneInput): string | null {
  const raw = lane.observe?.metadata?.session?.adapterType
    ?? lane.observe?.metadata?.session?.source
    ?? lane.agent.harness;
  const trimmed = raw?.trim().toLowerCase() ?? "";
  return trimmed || null;
}

function observedSessionRef(lane: RecapLaneInput): string | null {
  const raw = lane.observe?.metadata?.session?.externalSessionId
    ?? lane.agent.harnessSessionId
    ?? lane.observe?.metadata?.session?.threadId;
  const trimmed = raw?.trim() ?? "";
  return trimmed || null;
}

function nativeKey(harness: string, sessionRef: string, nodeId: string | null): string {
  return [nodeId ?? "local", harness, sessionRef].join("|");
}

export function recapTargetsFromLanes(lanes: readonly RecapLaneInput[]): RecapTarget[] {
  const groups = new Map<string, RecapLaneInput[]>();
  for (const lane of lanes) {
    const harness = observedHarness(lane);
    const sessionRef = observedSessionRef(lane);
    if (!harness || !sessionRef) continue;
    const key = `${harness}\0${sessionRef}`;
    const group = groups.get(key) ?? [];
    group.push(lane);
    groups.set(key, group);
  }

  const targets: RecapTarget[] = [];
  for (const group of groups.values()) {
    const lane = group[0]!;
    const harness = observedHarness(lane)!;
    const sessionRef = observedSessionRef(lane)!;
    const nodeId = lane.agent.homeNodeId?.trim() || null;
    const sourceExact = `${harness} · ${shortSession(sessionRef)}`;
    const uniqueScout = group.filter((item) => item.source === "scout");
    const identityVerified = uniqueScout.length === 1 && group.length === 1;
    const scout = uniqueScout[0]?.agent;
    targets.push({
      sessionRef,
      harness,
      voiceKey: identityVerified && scout ? scout.id : nativeKey(harness, sessionRef, nodeId),
      displayLabel: identityVerified && scout
        ? (scout.handle?.trim() || scout.name)
        : sourceExact,
      identityVerified,
      sourceExact,
      observedAt: lane.lastActiveAt > 0 ? lane.lastActiveAt : null,
      reportedState: lane.agent.state,
      nodeId,
    });
  }
  return targets;
}
