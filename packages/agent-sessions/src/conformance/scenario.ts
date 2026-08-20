import type {
  AdapterControlEvent,
  AdapterReplayRecord,
} from "../protocol/normalizer.js";

export type ScenarioEndState = "completed" | "failed" | "stopped" | "open";

export type ScenarioSourceKind = "recorded" | "synthetic";

export type ScenarioRedaction = {
  line: number;
  pointer: string;
  replacement: string;
};

export type ScenarioManifest = {
  schemaVersion: "1.0.0";
  id: string;
  adapterId: string;
  fixtureSet: string;
  source: {
    kind: ScenarioSourceKind;
    harnessVersion: string;
    transport: string;
    capturedAt: string;
  };
  redactions?: ScenarioRedaction[];
  expected: {
    endState: ScenarioEndState;
    evidenceKeys: string[];
    openReason?: string;
  };
  determinism: {
    clockValues: string[];
    idValues: string[];
  };
  session?: {
    name?: string;
    cwd?: string;
    model?: string;
  };
};

const EVIDENCE_KEY_PATTERN = /^(?:event:[a-z0-9:_-]+|capability:\/[A-Za-z0-9_./#-]+)$/u;
const SLUG_PATTERN = /^[a-z0-9-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Number.isFinite(Date.parse(value));
}

export function validateScenarioManifest(
  value: unknown,
  filePath = "<memory>",
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${filePath}: scenario must be an object`];
  }
  const scenario = value;

  if (scenario.schemaVersion !== "1.0.0") {
    errors.push(`${filePath}: schemaVersion must be "1.0.0"`);
  }
  if (typeof scenario.id !== "string" || !scenario.id.trim()) {
    errors.push(`${filePath}: id is required`);
  } else if (!SLUG_PATTERN.test(scenario.id)) {
    errors.push(`${filePath}: id must match ^[a-z0-9-]+$`);
  }
  if (typeof scenario.adapterId !== "string" || !scenario.adapterId.trim()) {
    errors.push(`${filePath}: adapterId is required`);
  } else if (!SLUG_PATTERN.test(scenario.adapterId)) {
    errors.push(`${filePath}: adapterId must match ^[a-z0-9-]+$`);
  }
  if (typeof scenario.fixtureSet !== "string" || !scenario.fixtureSet.trim()) {
    errors.push(`${filePath}: fixtureSet is required`);
  } else if (!SLUG_PATTERN.test(scenario.fixtureSet)) {
    errors.push(`${filePath}: fixtureSet must match ^[a-z0-9-]+$`);
  }

  const source = scenario.source;
  if (!isRecord(source)) {
    errors.push(`${filePath}: source is required`);
  } else {
    if (source.kind !== "recorded" && source.kind !== "synthetic") {
      errors.push(`${filePath}: source.kind must be recorded|synthetic`);
    }
    for (const key of ["harnessVersion", "transport"] as const) {
      if (typeof source[key] !== "string" || !(source[key] as string).trim()) {
        errors.push(`${filePath}: source.${key} is required`);
      }
    }
    if (!isDateTime(source.capturedAt)) {
      errors.push(`${filePath}: source.capturedAt must be a date-time`);
    }
  }

  const expected = scenario.expected;
  if (!isRecord(expected)) {
    errors.push(`${filePath}: expected is required`);
  } else {
    if (!["completed", "failed", "stopped", "open"].includes(String(expected.endState))) {
      errors.push(`${filePath}: expected.endState must be completed|failed|stopped|open`);
    }
    if (!Array.isArray(expected.evidenceKeys)) {
      errors.push(`${filePath}: expected.evidenceKeys must be an array`);
    } else {
      for (const key of expected.evidenceKeys) {
        if (typeof key !== "string" || !EVIDENCE_KEY_PATTERN.test(key)) {
          errors.push(`${filePath}: invalid evidence key: ${String(key)}`);
        }
      }
    }
    if (expected.endState === "open" && (typeof expected.openReason !== "string" || !expected.openReason.trim())) {
      errors.push(`${filePath}: expected.openReason is required when endState is open`);
    }
  }

  const determinism = scenario.determinism;
  if (!isRecord(determinism)) {
    errors.push(`${filePath}: determinism is required`);
  } else {
    if (!Array.isArray(determinism.clockValues) || determinism.clockValues.some((v) => !isDateTime(v))) {
      errors.push(`${filePath}: determinism.clockValues must be date-time[]`);
    }
    if (!Array.isArray(determinism.idValues) || determinism.idValues.some((v) => typeof v !== "string")) {
      errors.push(`${filePath}: determinism.idValues must be string[]`);
    }
  }

  if (scenario.redactions !== undefined) {
    if (!Array.isArray(scenario.redactions)) {
      errors.push(`${filePath}: redactions must be an array`);
    } else {
      for (const [index, entry] of scenario.redactions.entries()) {
        if (!isRecord(entry)) {
          errors.push(`${filePath}: redactions[${index}] must be an object`);
          continue;
        }
        const redaction = entry;
        if (typeof redaction.line !== "number" || !Number.isInteger(redaction.line) || redaction.line < 0) {
          errors.push(`${filePath}: redactions[${index}].line must be a non-negative integer`);
        }
        if (typeof redaction.pointer !== "string" || !redaction.pointer.startsWith("/")) {
          errors.push(`${filePath}: redactions[${index}].pointer must be an RFC 6901 pointer`);
        }
        if (typeof redaction.replacement !== "string") {
          errors.push(`${filePath}: redactions[${index}].replacement must be a string`);
        }
      }
    }
  }

  return errors;
}

function resolveJsonPointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    if (/~(?![01])/u.test(rawToken)) return { found: false };
    const token = rawToken.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, token)) {
      return { found: false };
    }
    current = current[token];
  }
  return { found: true, value: current };
}

/** Verify that every declared exact replacement is present in the checked-in capture. */
export function validateAppliedRedactions(
  scenario: ScenarioManifest,
  raw: string,
  filePath = "<memory>",
): string[] {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const parsedLines = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  });
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const redaction of scenario.redactions ?? []) {
    const key = `${redaction.line}:${redaction.pointer}`;
    if (seen.has(key)) {
      errors.push(`${filePath}: duplicate redaction ${key}`);
      continue;
    }
    seen.add(key);

    const line = parsedLines[redaction.line];
    if (line === undefined) {
      errors.push(`${filePath}: redaction line ${redaction.line} does not exist or is invalid JSON`);
      continue;
    }
    const resolved = resolveJsonPointer(line, redaction.pointer);
    if (!resolved.found) {
      errors.push(`${filePath}: redaction pointer ${redaction.pointer} does not resolve on line ${redaction.line}`);
      continue;
    }
    if (resolved.value !== redaction.replacement) {
      errors.push(`${filePath}: redaction ${key} does not contain its declared replacement`);
    }
  }

  return errors;
}

export function parseCaptureRecords(
  raw: string,
  filePath = "<memory>",
): { records: AdapterReplayRecord[]; errors: string[] } {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const records: AdapterReplayRecord[] = [];
  const errors: string[] = [];
  const seen = new Set<number>();

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${filePath}:${index + 1}: invalid JSON`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`${filePath}:${index + 1}: record must be an object`);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.sequence !== "number" || !Number.isInteger(record.sequence)) {
      errors.push(`${filePath}:${index + 1}: sequence must be an integer`);
      continue;
    }
    if (seen.has(record.sequence)) {
      errors.push(`${filePath}:${index + 1}: duplicate sequence ${record.sequence}`);
    }
    seen.add(record.sequence);

    if (record.source === "harness") {
      records.push({
        source: "harness",
        sequence: record.sequence,
        payload: record.payload,
      });
      continue;
    }

    if (record.source === "adapter_control") {
      if (typeof record.event !== "string") {
        errors.push(`${filePath}:${index + 1}: adapter_control.event is required`);
        continue;
      }
      records.push({
        source: "adapter_control",
        sequence: record.sequence,
        event: record.event as AdapterControlEvent,
        turnId: typeof record.turnId === "string" ? record.turnId : undefined,
        payload: record.payload,
      });
      continue;
    }

    errors.push(`${filePath}:${index + 1}: source must be harness|adapter_control`);
  }

  records.sort((a, b) => a.sequence - b.sequence);
  for (let expected = 0; expected < records.length; expected += 1) {
    if (records[expected]?.sequence !== expected) {
      errors.push(`${filePath}: sequences must start at 0 and increase by 1 (missing ${expected})`);
      break;
    }
  }

  return { records, errors };
}
