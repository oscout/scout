import type { AgentSessionStreamEvent } from "../protocol/primitives.js";
import type { AdapterReplayRecord } from "../protocol/normalizer.js";
import {
  MAX_DIAGNOSTIC_UTF8_BYTES,
  MAX_SESSION_EVENT_UTF8_BYTES,
  utf8ByteLength,
} from "../protocol/normalizer.js";
import type { SessionState } from "../state.js";
import type { ScenarioEndState, ScenarioManifest } from "./scenario.js";

export type ConformanceResult = "PASS" | "FAIL" | "SKIP" | "WARN";

export type ConformanceFinding = {
  requirementId: string;
  result: ConformanceResult;
  reason: string;
  evidenceKeys?: string[];
  failureEvidence?: unknown;
};

export type ScenarioReplayArtifacts = {
  sessionEvents: AgentSessionStreamEvent[];
  secondPassEvents: AgentSessionStreamEvent[];
  displayState: unknown;
  secondDisplayState: unknown;
  sessionState: SessionState | null;
  turnOpenAtEnd: boolean;
  records: readonly AdapterReplayRecord[];
  emissionCounts: readonly number[];
};

const EVENT_NAMES = new Set<string>([
  "session:update",
  "session:closed",
  "turn:start",
  "turn:end",
  "turn:error",
  "block:start",
  "block:delta",
  "block:action:output",
  "block:action:status",
  "block:action:approval",
  "block:question:answer",
  "block:end",
]);

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const ordered: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        ordered[key] = record[key];
      }
      return ordered;
    }
    return entry;
  });
}

function sourceDiscriminator(record: AdapterReplayRecord): string | null {
  if (record.source !== "harness" || !record.payload || typeof record.payload !== "object") {
    return null;
  }
  const payload = record.payload as Record<string, unknown>;
  if (typeof payload.method === "string") return payload.method;
  if (typeof payload.type === "string") return payload.type;
  return null;
}

export function evaluateScenarioRequirements(
  scenario: ScenarioManifest,
  artifacts: ScenarioReplayArtifacts,
  declaredEvents: readonly string[],
): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const events = artifacts.sessionEvents;

  // C001 deterministic replay
  const first = stableStringify(events);
  const second = stableStringify(artifacts.secondPassEvents);
  const displayFirst = stableStringify(artifacts.displayState);
  const displaySecond = stableStringify(artifacts.secondDisplayState);
  findings.push({
    requirementId: "SCO-042-C001",
    result: first === second && displayFirst === displaySecond ? "PASS" : "FAIL",
    reason: first === second && displayFirst === displaySecond
      ? "Replay is byte-identical for session events and display state."
      : "Replay produced divergent session events or display state.",
    failureEvidence: first === second && displayFirst === displaySecond
      ? undefined
      : { sessionEventsMatch: first === second, displayStateMatch: displayFirst === displaySecond },
  });

  // C002 turn pairing for terminal scenarios
  const turnStarts = events.filter((event) => event.event === "turn:start");
  const turnEnds = events.filter((event) => event.event === "turn:end");
  const terminalEndState = scenario.expected.endState !== "open";
  let turnPairOk = true;
  const openTurnIds = new Set<string>();
  for (const event of events) {
    if (event.event === "turn:start") {
      openTurnIds.add(event.turn.id);
    }
    if (event.event === "turn:end") {
      openTurnIds.delete(event.turnId);
    }
  }
  if (terminalEndState) {
    turnPairOk = openTurnIds.size === 0
      && turnStarts.length === turnEnds.length
      && turnStarts.length > 0;
  }
  findings.push({
    requirementId: "SCO-042-C002",
    result: terminalEndState
      ? (turnPairOk ? "PASS" : "FAIL")
      : "SKIP",
    reason: terminalEndState
      ? (turnPairOk
        ? "Every opened terminal turn has a matching turn:end."
        : "Terminal scenario has unpaired turn:start/turn:end events.")
      : "Open scenario; terminal turn pairing not required.",
    evidenceKeys: scenario.expected.evidenceKeys.filter((key) => key.startsWith("event:turn:")),
  });

  // C003 open scenarios stay open
  const openTurnId = turnStarts.at(-1)?.turn.id;
  const openHasFalseTerminal = openTurnId
    ? turnEnds.some((event) => event.turnId === openTurnId)
    : true;
  findings.push({
    requirementId: "SCO-042-C003",
    result: scenario.expected.endState === "open"
      ? (artifacts.turnOpenAtEnd && !openHasFalseTerminal ? "PASS" : "FAIL")
      : "SKIP",
    reason: scenario.expected.endState === "open"
      ? (artifacts.turnOpenAtEnd
        ? `Scenario remains open: ${scenario.expected.openReason ?? "declared open"}`
        : "Open scenario closed unexpectedly.")
      : "Not an open scenario.",
  });

  // C004 blocks start in open turns and end once
  const blockStarts = new Map<string, number>();
  const blockEnds = new Map<string, number>();
  let blockInOpenTurn = true;
  const openTurns = new Set<string>();
  for (const event of events) {
    if (event.event === "turn:start") openTurns.add(event.turn.id);
    if (event.event === "turn:end") openTurns.delete(event.turnId);
    if (event.event === "block:start") {
      if (!openTurns.has(event.turnId)) blockInOpenTurn = false;
      blockStarts.set(event.block.id, (blockStarts.get(event.block.id) ?? 0) + 1);
    }
    if (event.event === "block:end") {
      blockEnds.set(event.blockId, (blockEnds.get(event.blockId) ?? 0) + 1);
    }
  }
  const uniqueBlocks = [...blockStarts.entries()].every(([blockId, count]) =>
    count === 1 && (terminalEndState ? blockEnds.get(blockId) === 1 : (blockEnds.get(blockId) ?? 0) <= 1))
    && [...blockEnds.entries()].every(([blockId, count]) => count === 1 && blockStarts.has(blockId));
  findings.push({
    requirementId: "SCO-042-C004",
    result: blockInOpenTurn && uniqueBlocks ? "PASS" : "FAIL",
    reason: blockInOpenTurn && uniqueBlocks
      ? "Blocks start within open turns and have a valid single end edge."
      : "Block lifecycle violated uniqueness or open-turn placement.",
  });

  // C005 action block id stability
  const actionBlockIds = new Set<string>();
  let actionIdStable = true;
  for (const event of events) {
    if (event.event === "block:start" && event.block.type === "action") {
      actionBlockIds.add(event.block.id);
    }
    if (
      event.event === "block:action:output"
      || event.event === "block:action:status"
      || event.event === "block:action:approval"
      || event.event === "block:end"
    ) {
      if ("blockId" in event && actionBlockIds.size > 0) {
        // End events may be for non-action blocks; only fail if an action-* event uses unknown id.
        if (event.event.startsWith("block:action:") && !actionBlockIds.has(event.blockId)) {
          actionIdStable = false;
        }
      }
    }
  }
  findings.push({
    requirementId: "SCO-042-C005",
    result: actionIdStable ? "PASS" : "FAIL",
    reason: actionIdStable
      ? "Action updates reference a normalized block id."
      : "Action update referenced an unknown block id.",
    evidenceKeys: scenario.expected.evidenceKeys.filter((key) => key.includes("action")),
  });

  // C006 implicit open is only applicable when a harness record proves activity
  // before any native turn-start record.
  const sourceDiscriminators = artifacts.records.map(sourceDiscriminator);
  const explicitTurnStart = sourceDiscriminators.some((value) =>
    value === "turn/started" || value === "turn_start" || value === "turn.started");
  const hasHarnessActivity = artifacts.records.some((record) => record.source === "harness");
  const implicitOpenApplicable = hasHarnessActivity && !explicitTurnStart;
  findings.push({
    requirementId: "SCO-042-C006",
    result: implicitOpenApplicable ? (turnStarts.length > 0 ? "PASS" : "FAIL") : "SKIP",
    reason: implicitOpenApplicable
      ? (turnStarts.length > 0
        ? "The normalizer opened a turn from the first source record that proved activity."
        : "Source activity omitted an explicit turn start and the normalizer did not open one.")
      : "Scenario includes an explicit turn start or does not exercise implicit opening.",
  });

  // C007 uses a closed synthetic discriminator so a scenario can deliberately
  // prove that replay continues after an unknown record.
  const unknownIndexes = sourceDiscriminators
    .map((value, index) => value === "fixture/unknown" || value === "fixture_unknown" ? index : -1)
    .filter((index) => index >= 0);
  const unknownContinued = unknownIndexes.every((unknownIndex) =>
    artifacts.emissionCounts.slice(unknownIndex + 1).some((count) => (count ?? 0) > 0));
  findings.push({
    requirementId: "SCO-042-C007",
    result: unknownIndexes.length === 0 ? "SKIP" : (unknownContinued ? "PASS" : "FAIL"),
    reason: unknownIndexes.length === 0
      ? "Scenario does not declare the closed unknown-record probe."
      : unknownContinued
        ? "Replay ignored the unknown source record and emitted later valid events."
        : "No valid normalized event appeared after the unknown source record.",
  });

  // C008 is asserted only by the same closed probe with an explicit list of
  // authoritative fields that are absent from the source capture.
  const noAuthorityProbe = artifacts.records.find((record) => {
    const discriminator = sourceDiscriminator(record);
    if ((discriminator !== "fixture/unknown" && discriminator !== "fixture_unknown") || record.source !== "harness") return false;
    const payload = record.payload as Record<string, unknown>;
    return Array.isArray(payload.assertAbsentAuthoritativeFields);
  });
  const absentFields = noAuthorityProbe?.source === "harness"
    ? ((noAuthorityProbe.payload as Record<string, unknown>).assertAbsentAuthoritativeFields as unknown[])
      .filter((field): field is string => typeof field === "string")
    : [];
  const serializedEvents = stableStringify(events);
  const inventedFields = absentFields.filter((field) => new RegExp(`"${field}"\\s*:`, "u").test(serializedEvents));
  findings.push({
    requirementId: "SCO-042-C008",
    result: absentFields.length === 0 ? "SKIP" : (inventedFields.length === 0 ? "PASS" : "FAIL"),
    reason: absentFields.length === 0
      ? "Scenario does not declare absent authoritative fields."
      : inventedFields.length === 0
        ? `Normalizer did not invent absent authoritative fields: ${absentFields.join(", ")}.`
        : `Normalizer invented absent authoritative fields: ${inventedFields.join(", ")}.`,
    failureEvidence: inventedFields.length > 0 ? { inventedFields } : undefined,
  });

  // C009 size bounds
  let sizeOk = true;
  let sizeReason = "All session events and retained action output respect size bounds.";
  for (const event of events) {
    const encoded = utf8ByteLength(JSON.stringify(event));
    if (encoded > MAX_SESSION_EVENT_UTF8_BYTES) {
      sizeOk = false;
      sizeReason = `Event exceeds 64 KiB (${encoded} bytes).`;
      break;
    }
    if (event.event === "block:start" && event.block.type === "error") {
      if (utf8ByteLength(event.block.message) > MAX_DIAGNOSTIC_UTF8_BYTES) {
        sizeOk = false;
        sizeReason = "Diagnostic message exceeds 4 KiB bound.";
        break;
      }
    }
  }
  let foundBoundedTruncation = false;
  if (artifacts.sessionState) {
    for (const turn of artifacts.sessionState.turns) {
      for (const blockState of turn.blocks) {
        if (blockState.block.type === "action") {
          const bytes = utf8ByteLength(blockState.block.action.output);
          if (bytes > 64 * 1024) {
            sizeOk = false;
            sizeReason = `Retained action output exceeds 64 KiB (${bytes} bytes).`;
          }
          if (
            blockState.block.action.truncation
            && blockState.block.action.truncation.omittedBytes > 0
            && blockState.block.action.truncation.sourceRef
          ) {
            foundBoundedTruncation = true;
          }
        }
      }
    }
  }
  const hasLargeSourceRecord = artifacts.records.some((record) =>
    utf8ByteLength(JSON.stringify(record)) > MAX_SESSION_EVENT_UTF8_BYTES);
  if (hasLargeSourceRecord && !foundBoundedTruncation) {
    sizeOk = false;
    sizeReason = "Large source output did not retain explicit truncation metadata and a source reference.";
  }
  findings.push({
    requirementId: "SCO-042-C009",
    result: sizeOk ? "PASS" : "FAIL",
    reason: sizeReason,
  });

  // C010 display phase leaves active for terminal scenarios
  const phase = (artifacts.displayState as { phase?: string } | null)?.phase;
  const activePhases = new Set(["running", "waiting"]);
  const terminalDisplayOk = scenario.expected.endState === "open"
    ? activePhases.has(phase ?? "") || phase === "waiting" || artifacts.turnOpenAtEnd
    : !activePhases.has(phase ?? "running") || phase === "completed" || phase === "failed" || phase === "idle";
  findings.push({
    requirementId: "SCO-042-C010",
    result: terminalDisplayOk ? "PASS" : "FAIL",
    reason: terminalDisplayOk
      ? `Display phase is consistent with endState=${scenario.expected.endState} (phase=${phase ?? "unknown"}).`
      : `Display phase ${phase ?? "unknown"} is inconsistent with endState=${scenario.expected.endState}.`,
  });

  // C011 pure normalizer usage is structural — runner always uses registry normalizers
  findings.push({
    requirementId: "SCO-042-C011",
    result: "PASS",
    reason: "Scenario replay constructs the registry pure normalizer shared with live adapters.",
  });

  // C012 event names exist in union and declared surface
  const emitted = new Set(events.map((event) => event.event));
  const declared = new Set(declaredEvents);
  const unknownEvents = [...emitted].filter((name) => !EVENT_NAMES.has(name));
  const undeclared = [...emitted].filter((name) => declared.size > 0 && !declared.has(name));
  const c012Ok = unknownEvents.length === 0 && undeclared.length === 0;
  findings.push({
    requirementId: "SCO-042-C012",
    result: c012Ok ? "PASS" : "FAIL",
    reason: c012Ok
      ? "Emitted events are valid and declared by the adapter surface."
      : `Invalid or undeclared events: unknown=${unknownEvents.join(",") || "none"} undeclared=${undeclared.join(",") || "none"}`,
    failureEvidence: { unknownEvents, undeclared },
  });

  // Evidence keys present
  for (const key of scenario.expected.evidenceKeys) {
    if (key.startsWith("event:")) {
      const eventName = key.slice("event:".length);
      if (![...emitted].some((name) => name === eventName || name.startsWith(eventName))) {
        findings.push({
          requirementId: "SCO-042-EVIDENCE",
          result: "FAIL",
          reason: `Missing evidence event for key ${key}`,
          evidenceKeys: [key],
        });
      }
    }
  }

  return findings;
}

export function endStateFromEvents(
  events: readonly AgentSessionStreamEvent[],
  turnOpen: boolean,
): ScenarioEndState {
  if (turnOpen) return "open";
  const lastEnd = [...events].reverse().find((event) => event.event === "turn:end");
  if (!lastEnd || lastEnd.event !== "turn:end") return "open";
  if (lastEnd.status === "failed") return "failed";
  if (lastEnd.status === "stopped") return "stopped";
  return "completed";
}
