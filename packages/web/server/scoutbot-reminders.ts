import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

export type ScoutbotReminderSource = "scoutbot" | "api";
export type StoredScoutbotReminderStatus = "scheduled" | "dismissed";
export type ScoutbotReminderStatus = StoredScoutbotReminderStatus | "due";

export type ScoutbotReminder = {
  id: string;
  title: string;
  body: string;
  status: ScoutbotReminderStatus;
  source: ScoutbotReminderSource;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  dueInMs: number;
  dismissedAt?: number;
  context?: Record<string, unknown>;
};

type StoredScoutbotReminder = Omit<ScoutbotReminder, "status" | "dueInMs"> & {
  status: StoredScoutbotReminderStatus;
};

export type ScoutbotReminderState = {
  generatedAt: number;
  reminders: ScoutbotReminder[];
  due: ScoutbotReminder[];
  scheduled: ScoutbotReminder[];
};

export type ScoutbotReminderCreateInput = {
  title?: unknown;
  body?: unknown;
  source?: unknown;
  dueAt?: unknown;
  delayMs?: unknown;
  delayMinutes?: unknown;
  context?: unknown;
};

type ScoutbotReminderFile = {
  version: 1;
  reminders: StoredScoutbotReminder[];
};

export class ScoutbotReminderError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ScoutbotReminderError";
    this.status = status;
  }
}

export function createScoutbotReminderStore(input: {
  filePath?: string;
  now?: () => number;
} = {}) {
  const filePath = input.filePath ?? join(resolveOpenScoutSupportPaths().controlHome, "scoutbot-reminders.json");
  const now = input.now ?? Date.now;

  const readReminders = (): StoredScoutbotReminder[] => {
    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ScoutbotReminderFile>;
      if (!Array.isArray(parsed.reminders)) {
        return [];
      }
      return parsed.reminders.filter(isStoredReminder);
    } catch {
      return [];
    }
  };

  const writeReminders = (reminders: StoredScoutbotReminder[]): void => {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ version: 1, reminders }, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  };

  const stateFrom = (reminders: StoredScoutbotReminder[]): ScoutbotReminderState => {
    const generatedAt = now();
    const publicReminders = reminders
      .map((reminder) => publicReminder(reminder, generatedAt))
      .sort((left, right) => {
        if (left.status === "due" && right.status !== "due") return -1;
        if (left.status !== "due" && right.status === "due") return 1;
        return left.dueAt - right.dueAt;
      });
    return {
      generatedAt,
      reminders: publicReminders,
      due: publicReminders.filter((reminder) => reminder.status === "due"),
      scheduled: publicReminders.filter((reminder) => reminder.status === "scheduled"),
    };
  };

  return {
    getState: (): ScoutbotReminderState => stateFrom(readReminders()),
    create: (input: ScoutbotReminderCreateInput): ScoutbotReminderState & { reminder: ScoutbotReminder } => {
      const createdAt = now();
      const body = stringValue(input.body)?.trim();
      if (!body) {
        throw new ScoutbotReminderError("reminder body is required", 400);
      }

      const dueAt = resolveDueAt(input, createdAt);
      const source = input.source === "api" ? "api" : "scoutbot";
      const title = firstNonEmptyString(
        stringValue(input.title),
        titleFromBody(body),
      ) ?? "Reminder";
      const context = recordValue(input.context);
      const stored: StoredScoutbotReminder = {
        id: `rem_${randomUUID()}`,
        title,
        body,
        status: "scheduled",
        source,
        createdAt,
        updatedAt: createdAt,
        dueAt,
        ...(context ? { context } : {}),
      };
      const reminders = [stored, ...readReminders()];
      writeReminders(reminders);
      const state = stateFrom(reminders);
      return {
        ...state,
        reminder: publicReminder(stored, state.generatedAt),
      };
    },
    dismiss: (id: string): ScoutbotReminderState => {
      const trimmedId = id.trim();
      if (!trimmedId) {
        throw new ScoutbotReminderError("reminder id is required", 400);
      }
      const updatedAt = now();
      const reminders = readReminders();
      const index = reminders.findIndex((reminder) => reminder.id === trimmedId);
      if (index === -1) {
        throw new ScoutbotReminderError("reminder not found", 404);
      }
      reminders[index] = {
        ...reminders[index],
        status: "dismissed",
        updatedAt,
        dismissedAt: updatedAt,
      };
      writeReminders(reminders);
      return stateFrom(reminders);
    },
  };
}

function publicReminder(reminder: StoredScoutbotReminder, now: number): ScoutbotReminder {
  const dueInMs = reminder.dueAt - now;
  const status = reminder.status === "scheduled" && dueInMs <= 0
    ? "due"
    : reminder.status;
  return {
    ...reminder,
    status,
    dueInMs,
  };
}

function resolveDueAt(input: ScoutbotReminderCreateInput, now: number): number {
  const explicitDueAt = numberValue(input.dueAt);
  if (explicitDueAt !== null) {
    return validateDueAt(explicitDueAt);
  }

  const delayMs = numberValue(input.delayMs);
  if (delayMs !== null) {
    return validateDueAt(now + Math.max(0, delayMs));
  }

  const delayMinutes = numberValue(input.delayMinutes);
  if (delayMinutes !== null) {
    return validateDueAt(now + Math.max(0, delayMinutes) * 60_000);
  }

  throw new ScoutbotReminderError("dueAt, delayMs, or delayMinutes is required", 400);
}

function validateDueAt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScoutbotReminderError("reminder due time must be a finite timestamp", 400);
  }
  return Math.round(value);
}

function isStoredReminder(value: unknown): value is StoredScoutbotReminder {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredScoutbotReminder>;
  return typeof record.id === "string"
    && typeof record.title === "string"
    && typeof record.body === "string"
    && (record.status === "scheduled" || record.status === "dismissed")
    && (record.source === "scoutbot" || record.source === "api")
    && typeof record.createdAt === "number"
    && typeof record.updatedAt === "number"
    && typeof record.dueAt === "number";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function titleFromBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 42) {
    return normalized;
  }
  return `${normalized.slice(0, 39).trim()}...`;
}
