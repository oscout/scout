import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSessionStreamEvent, Session } from "../protocol/primitives.js";
import type { HarnessEventNormalizerContext } from "../protocol/normalizer.js";
import { StateTracker } from "../state.js";
import {
  evaluateScenarioRequirements,
  type ConformanceFinding,
} from "./checks.js";
import { resolveNormalizerFactory } from "./registry.js";
import {
  parseCaptureRecords,
  validateAppliedRedactions,
  validateScenarioManifest,
  type ScenarioManifest,
} from "./scenario.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES_ROOT = join(PACKAGE_ROOT, "fixtures/harness-events");
const ADAPTERS_ROOT = join(PACKAGE_ROOT, "src/adapters");

export type AdapterSpecSummary = {
  path: string;
  adapterId: string;
  specVersion: string;
  conformance?: {
    status: "required" | "grandfathered";
    normalizerId: string;
    fixtureSets: string[];
  };
  emitsPairingEvents: string[];
};

export type ScenarioReport = {
  scenarioId: string;
  adapterId: string;
  normalizerId: string;
  fixtureSet: string;
  sourceKind: string;
  findings: ConformanceFinding[];
  failed: boolean;
};

export type ConformanceReport = {
  generatedAt: string;
  adapterFilter: string | null;
  scenarios: ScenarioReport[];
  adapters: Array<{
    adapterId: string;
    normalizerId: string | null;
    status: "required" | "grandfathered" | "missing-spec";
    findings: ConformanceFinding[];
  }>;
  failed: boolean;
  summary: {
    scenarioCount: number;
    failCount: number;
    warnCount: number;
    passCount: number;
  };
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectScenarioDirs(root: string): string[] {
  if (!isDirectory(root)) return [];
  const dirs: string[] = [];
  for (const fixtureSet of readdirSync(root).sort()) {
    const fixtureSetPath = join(root, fixtureSet);
    if (!isDirectory(fixtureSetPath) || fixtureSet.endsWith(".json")) continue;
    for (const scenario of readdirSync(fixtureSetPath).sort()) {
      const scenarioPath = join(fixtureSetPath, scenario);
      if (!isDirectory(scenarioPath)) continue;
      try {
        if (statSync(join(scenarioPath, "scenario.json")).isFile()) {
          dirs.push(scenarioPath);
        }
      } catch {
        // Ignore incomplete or intentionally empty fixture directories.
      }
    }
  }
  return dirs;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createDeterministicContext(
  sessionId: string,
  clockValues: string[],
  idValues: string[],
): {
  context: HarnessEventNormalizerContext;
  assertExhausted: () => string[];
} {
  let clockIndex = 0;
  let idIndex = 0;
  const errors: string[] = [];

  const context: HarnessEventNormalizerContext = {
    sessionId,
    now: () => {
      const value = clockValues[clockIndex];
      if (value === undefined) {
        errors.push("clockValues exhausted");
        return "1970-01-01T00:00:00.000Z";
      }
      clockIndex += 1;
      return value;
    },
    nextId: () => {
      const value = idValues[idIndex];
      if (value === undefined) {
        errors.push("idValues exhausted");
        return `overflow-id-${idIndex++}`;
      }
      idIndex += 1;
      return value;
    },
  };

  return {
    context,
    assertExhausted: () => {
      if (clockIndex < clockValues.length) {
        errors.push(`unused clockValues: ${clockValues.length - clockIndex}`);
      }
      if (idIndex < idValues.length) {
        errors.push(`unused idValues: ${idValues.length - idIndex}`);
      }
      return errors;
    },
  };
}

export type DisplayStateProjector = (
  sessionState: NonNullable<ReturnType<StateTracker["getSessionState"]>>,
  options: { now: number },
) => unknown;

function projectDisplayState(
  projector: DisplayStateProjector,
  sessionState: ReturnType<StateTracker["getSessionState"]>,
  nowIso: string,
): unknown {
  if (!sessionState) return null;
  const now = Date.parse(nowIso);
  return projector(sessionState, {
    now: Number.isFinite(now) ? now : 0,
  });
}

function loadAdapterSpecs(): AdapterSpecSummary[] {
  const specs: AdapterSpecSummary[] = [];
  for (const entry of readdirSync(ADAPTERS_ROOT).sort()) {
    const specPath = join(ADAPTERS_ROOT, entry, "adapter.spec.json");
    try {
      if (!statSync(specPath).isFile()) continue;
    } catch {
      continue;
    }
    const raw = readJson<Record<string, unknown>>(specPath);
    const normalizedSurface = raw.normalizedSurface as { emitsPairingEvents?: string[] } | undefined;
    const conformance = raw.conformance as AdapterSpecSummary["conformance"] | undefined;
    specs.push({
      path: relative(PACKAGE_ROOT, specPath),
      adapterId: String(raw.adapterId ?? entry),
      specVersion: String(raw.specVersion ?? ""),
      conformance,
      emitsPairingEvents: normalizedSurface?.emitsPairingEvents ?? [],
    });
  }
  return specs;
}

function replayScenario(
  scenario: ScenarioManifest,
  records: ReturnType<typeof parseCaptureRecords>["records"],
  normalizerId: string,
): {
  events: AgentSessionStreamEvent[];
  sessionState: ReturnType<StateTracker["getSessionState"]>;
  turnOpen: boolean;
  contextErrors: string[];
  emissionCounts: number[];
} {
  const factory = resolveNormalizerFactory(normalizerId);
  if (!factory) {
    throw new Error(`Unknown normalizerId: ${normalizerId}`);
  }

  const sessionId = `fixture-${scenario.id}`;
  const { context, assertExhausted } = createDeterministicContext(
    sessionId,
    scenario.determinism.clockValues,
    scenario.determinism.idValues,
  );
  const normalizer = factory(context);
  const events: AgentSessionStreamEvent[] = [];
  const emissionCounts: number[] = [];
  for (const record of records) {
    const emitted = normalizer.ingest(record);
    emissionCounts[record.sequence] = emitted.length;
    events.push(...emitted);
  }
  events.push(...normalizer.finishReplay());
  const normalizedEventsSnapshot = JSON.stringify(events);

  const tracker = new StateTracker();
  const seedSession: Session = {
    id: sessionId,
    name: scenario.session?.name ?? scenario.adapterId,
    adapterType: scenario.adapterId,
    status: "active",
    cwd: scenario.session?.cwd,
    model: scenario.session?.model,
  };
  tracker.createSession(sessionId, seedSession);
  for (const event of events) {
    const capturedAt = event.event === "turn:start"
      ? event.turn.startedAt
      : event.event === "turn:end"
        ? scenario.determinism.clockValues.at(-1)
        : undefined;
    tracker.trackEvent(sessionId, event, capturedAt);
  }

  const contextErrors = assertExhausted();
  if (JSON.stringify(events) !== normalizedEventsSnapshot) {
    contextErrors.push("StateTracker mutated normalized session events during replay");
  }

  return {
    events,
    sessionState: tracker.getSessionState(sessionId),
    turnOpen: normalizer.turnOpen,
    contextErrors,
    emissionCounts,
  };
}

export async function runAdapterConformance(options: {
  adapterFilter?: string | null;
  fixturesRoot?: string;
  projectDisplayState: DisplayStateProjector;
}): Promise<ConformanceReport> {
  const fixturesRoot = options.fixturesRoot ?? FIXTURES_ROOT;
  const adapterFilter = options.adapterFilter ?? null;
  const specs = loadAdapterSpecs();
  const scenarioDirs = collectScenarioDirs(fixturesRoot);
  const scenarios: ScenarioReport[] = [];
  const adapterFindings = new Map<string, ConformanceFinding[]>();

  for (const spec of specs) {
    adapterFindings.set(spec.adapterId, []);
  }

  for (const scenarioDir of scenarioDirs) {
    const scenarioPath = join(scenarioDir, "scenario.json");
    const scenarioRaw = readJson<unknown>(scenarioPath);
    const scenarioErrors = validateScenarioManifest(scenarioRaw, scenarioPath);
    if (scenarioErrors.length > 0) {
      scenarios.push({
        scenarioId: relative(fixturesRoot, scenarioDir),
        adapterId: "unknown",
        normalizerId: "unknown",
        fixtureSet: "unknown",
        sourceKind: "unknown",
        findings: scenarioErrors.map((reason) => ({
          requirementId: "SCO-042-SCHEMA",
          result: "FAIL",
          reason,
        })),
        failed: true,
      });
      continue;
    }

    const scenario = scenarioRaw as ScenarioManifest;
    if (adapterFilter && scenario.adapterId !== adapterFilter && scenario.fixtureSet !== adapterFilter) {
      continue;
    }

    const captureRaw = readFileSync(join(scenarioDir, "capture.raw.jsonl"), "utf8");
    const { records, errors: parseErrors } = parseCaptureRecords(
      captureRaw,
      join(scenarioDir, "capture.raw.jsonl"),
    );
    const captureErrors = [
      ...parseErrors,
      ...validateAppliedRedactions(
        scenario,
        captureRaw,
        join(scenarioDir, "capture.raw.jsonl"),
      ),
    ];
    if (captureErrors.length > 0) {
      scenarios.push({
        scenarioId: scenario.id,
        adapterId: scenario.adapterId,
        normalizerId: scenario.adapterId,
        fixtureSet: scenario.fixtureSet,
        sourceKind: scenario.source.kind,
        findings: captureErrors.map((reason) => ({
          requirementId: "SCO-042-CAPTURE",
          result: "FAIL",
          reason,
        })),
        failed: true,
      });
      continue;
    }

    const matchingSpec = specs.find((spec) => spec.adapterId === scenario.adapterId);
    const normalizerId = matchingSpec?.conformance?.normalizerId
      ?? (scenario.adapterId === "echo" ? "echo" : scenario.adapterId);

    let first: ReturnType<typeof replayScenario>;
    let second: ReturnType<typeof replayScenario>;
    try {
      first = replayScenario(scenario, records, normalizerId);
      second = replayScenario(scenario, records, normalizerId);
    } catch (error) {
      scenarios.push({
        scenarioId: scenario.id,
        adapterId: scenario.adapterId,
        normalizerId,
        fixtureSet: scenario.fixtureSet,
        sourceKind: scenario.source.kind,
        findings: [{
          requirementId: "SCO-042-REPLAY",
          result: "FAIL",
          reason: error instanceof Error ? error.message : String(error),
        }],
        failed: true,
      });
      continue;
    }

    const expectedEventsPath = join(scenarioDir, "expected.session-events.json");
    const expectedDisplayPath = join(scenarioDir, "expected.display-state.json");
    const expectedEvents = readJson<AgentSessionStreamEvent[]>(expectedEventsPath);
    const expectedDisplay = readJson<unknown>(expectedDisplayPath);

    const displayState = projectDisplayState(
      options.projectDisplayState,
      first.sessionState,
      scenario.determinism.clockValues.at(-1) ?? "1970-01-01T00:00:00.000Z",
    );
    const secondDisplayState = projectDisplayState(
      options.projectDisplayState,
      second.sessionState,
      scenario.determinism.clockValues.at(-1) ?? "1970-01-01T00:00:00.000Z",
    );

    const findings = evaluateScenarioRequirements(
      scenario,
      {
        sessionEvents: first.events,
        secondPassEvents: second.events,
        displayState,
        secondDisplayState,
        sessionState: first.sessionState,
        turnOpenAtEnd: first.turnOpen,
        records,
        emissionCounts: first.emissionCounts,
      },
      matchingSpec?.emitsPairingEvents ?? [],
    );

    if (JSON.stringify(first.events) !== JSON.stringify(expectedEvents)) {
      findings.push({
        requirementId: "SCO-042-EXPECTED-EVENTS",
        result: "FAIL",
        reason: "Replay session events do not match expected.session-events.json",
        failureEvidence: {
          actualCount: first.events.length,
          expectedCount: expectedEvents.length,
          actual: first.events,
        },
      });
    } else {
      findings.push({
        requirementId: "SCO-042-EXPECTED-EVENTS",
        result: "PASS",
        reason: "Replay session events match expected.session-events.json",
      });
    }

    if (JSON.stringify(displayState) !== JSON.stringify(expectedDisplay)) {
      findings.push({
        requirementId: "SCO-042-EXPECTED-DISPLAY",
        result: "FAIL",
        reason: "Projected display state does not match expected.display-state.json",
        failureEvidence: { actual: displayState },
      });
    } else {
      findings.push({
        requirementId: "SCO-042-EXPECTED-DISPLAY",
        result: "PASS",
        reason: "Projected display state matches expected.display-state.json",
      });
    }

    for (const error of first.contextErrors) {
      findings.push({
        requirementId: "SCO-042-DETERMINISM",
        result: "FAIL",
        reason: error,
      });
    }

    const failed = findings.some((finding) => finding.result === "FAIL");
    scenarios.push({
      scenarioId: scenario.id,
      adapterId: scenario.adapterId,
      normalizerId,
      fixtureSet: scenario.fixtureSet,
      sourceKind: scenario.source.kind,
      findings,
      failed,
    });
  }

  // Adapter-level recorded evidence requirements
  const adapterReports: ConformanceReport["adapters"] = [];
  for (const spec of specs) {
    if (adapterFilter && spec.adapterId !== adapterFilter) continue;
    const findings: ConformanceFinding[] = [...(adapterFindings.get(spec.adapterId) ?? [])];
    const status = spec.conformance?.status ?? "grandfathered";
    const normalizerId = spec.conformance?.normalizerId ?? null;
    const related = scenarios.filter((scenario) =>
      scenario.adapterId === spec.adapterId
      || (spec.conformance?.fixtureSets ?? []).includes(scenario.fixtureSet),
    );
    const hasRecorded = related.some((scenario) => scenario.sourceKind === "recorded" && !scenario.failed);

    if (status === "required" && !hasRecorded) {
      findings.push({
        requirementId: "SCO-042-RECORDED",
        result: "FAIL",
        reason: "Required adapter has no passing recorded fixture evidence.",
      });
    } else if (status === "grandfathered") {
      findings.push({
        requirementId: "SCO-042-RECORDED",
        result: "WARN",
        reason: "Grandfathered adapter remains unverified until recorded fixtures land.",
      });
    } else if (hasRecorded) {
      findings.push({
        requirementId: "SCO-042-RECORDED",
        result: "PASS",
        reason: "Recorded fixture evidence present.",
      });
    }

    // Claimed emitsPairingEvents must have fixture evidence or explicit unverified
    if (status === "required") {
      const emittedInFixtures = new Set<string>();
      for (const scenarioDir of scenarioDirs) {
        const scenarioRaw = readJson<unknown>(join(scenarioDir, "scenario.json"));
        if (validateScenarioManifest(scenarioRaw, join(scenarioDir, "scenario.json")).length > 0) {
          continue;
        }
        const scenario = scenarioRaw as ScenarioManifest;
        const belongsToAdapter = scenario.adapterId === spec.adapterId
          || (spec.conformance?.fixtureSets ?? []).includes(scenario.fixtureSet);
        if (!belongsToAdapter || scenario.source.kind !== "recorded") continue;
        const report = related.find((candidate) =>
          candidate.scenarioId === scenario.id
          && candidate.adapterId === scenario.adapterId
          && candidate.sourceKind === "recorded"
        );
        if (!report || report.failed) continue;
        const events = readJson<AgentSessionStreamEvent[]>(join(scenarioDir, "expected.session-events.json"));
        for (const event of events) emittedInFixtures.add(event.event);
      }
      for (const declared of spec.emitsPairingEvents) {
        if (!emittedInFixtures.has(declared)) {
          findings.push({
            requirementId: "SCO-042-C012",
            result: "WARN",
            reason: `Declared event ${declared} has no recorded fixture evidence yet (unverified).`,
            evidenceKeys: [`event:${declared}`],
          });
        }
      }
    }

    adapterReports.push({
      adapterId: spec.adapterId,
      normalizerId,
      status,
      findings,
    });
  }

  // Echo self-test has no adapter.spec.json
  if (!adapterFilter || adapterFilter === "echo") {
    const echoScenarios = scenarios.filter((scenario) => scenario.adapterId === "echo");
    if (echoScenarios.length === 0) {
      adapterReports.push({
        adapterId: "echo",
        normalizerId: "echo",
        status: "missing-spec",
        findings: [{
          requirementId: "SCO-042-ECHO",
          result: "FAIL",
          reason: "Echo self-test fixture missing.",
        }],
      });
    }
  }

  const allFindings = [
    ...scenarios.flatMap((scenario) => scenario.findings),
    ...adapterReports.flatMap((adapter) => adapter.findings),
  ];
  const failCount = allFindings.filter((finding) => finding.result === "FAIL").length;
  const warnCount = allFindings.filter((finding) => finding.result === "WARN").length;
  const passCount = allFindings.filter((finding) => finding.result === "PASS").length;

  return {
    generatedAt: new Date().toISOString(),
    adapterFilter,
    scenarios,
    adapters: adapterReports,
    failed: failCount > 0 || scenarios.some((scenario) => scenario.failed),
    summary: {
      scenarioCount: scenarios.length,
      failCount,
      warnCount,
      passCount,
    },
  };
}

export function formatConformanceReportText(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`SCO-042 adapter conformance`);
  lines.push(`scenarios=${report.summary.scenarioCount} pass=${report.summary.passCount} warn=${report.summary.warnCount} fail=${report.summary.failCount}`);
  for (const scenario of report.scenarios) {
    const mark = scenario.failed ? "FAIL" : "PASS";
    lines.push(`[${mark}] scenario ${scenario.scenarioId} adapter=${scenario.adapterId} normalizer=${scenario.normalizerId}`);
    for (const finding of scenario.findings.filter((entry) => entry.result !== "PASS")) {
      lines.push(`  - ${finding.result} ${finding.requirementId}: ${finding.reason}`);
    }
  }
  for (const adapter of report.adapters) {
    for (const finding of adapter.findings.filter((entry) => entry.result !== "PASS")) {
      lines.push(`[${finding.result}] adapter ${adapter.adapterId} ${finding.requirementId}: ${finding.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
