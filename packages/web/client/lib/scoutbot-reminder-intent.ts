export type ScoutbotReminderIntent = {
  title: string;
  body: string;
  delayMs: number;
  dueAt: number;
};

const NUMBER_WORDS = new Map<string, number>([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["fifteen", 15],
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["forty-five", 45],
  ["sixty", 60],
]);

const AMOUNT = String.raw`(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|sixty)`;
const UNIT = String.raw`(seconds?|secs?|minutes?|mins?|hours?|hrs?)`;

const REMINDER_PATTERNS = [
  new RegExp(String.raw`\b(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:set\s+(?:a\s+)?reminder|remind\s+me|ping\s+me|nudge\s+me)(?:\s+for\s+(?:me|you|us))?\s+(?:in|after|for)\s+${AMOUNT}\s+${UNIT}\b(?:\s+(?:to|about|on|for)\s+(.+))?`, "i"),
  new RegExp(String.raw`\b(?:please\s+)?(?:check\s+back|follow\s+up)(?:\s+with\s+(?:me|us))?\s+(?:in|after)\s+${AMOUNT}\s+${UNIT}\b(?:\s+(?:to|about|on|for)\s+(.+))?`, "i"),
  new RegExp(String.raw`\b(?:please\s+)?(?:can\s+i\s+get|can\s+you\s+give\s+me|give\s+me|send\s+me|get\s+me)\s+(?:a\s+|an\s+)?(?:quick\s+|short\s+)?(?:status\s+)?update\s+(?:in|after)\s+${AMOUNT}\s+${UNIT}\b(?:\s+(?:to|about|on|for)\s+(.+))?`, "i"),
  new RegExp(String.raw`\bin\s+${AMOUNT}\s+${UNIT}\s+(?:remind\s+me|ping\s+me|nudge\s+me)(?:\s+(?:to|about|on|for)\s+(.+))?`, "i"),
];

export function parseScoutbotReminderIntent(
  input: string,
  now: number = Date.now(),
): ScoutbotReminderIntent | null {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  for (const pattern of REMINDER_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const amount = parseAmount(match[1] ?? "");
    const unit = match[2] ?? "";
    if (amount === null) continue;

    const delayMs = unitToMs(amount, unit);
    if (delayMs === null) continue;

    const body = normalizeReminderBody(match[3] ?? "", normalized);
    return {
      body,
      title: titleFromReminderBody(body),
      delayMs,
      dueAt: now + delayMs,
    };
  }

  return null;
}

function parseAmount(raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  const wordValue = NUMBER_WORDS.get(normalized);
  if (wordValue !== undefined) return wordValue;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function unitToMs(amount: number, rawUnit: string): number | null {
  const unit = rawUnit.trim().toLowerCase();
  if (unit.startsWith("sec")) return Math.round(amount * 1000);
  if (unit.startsWith("min")) return Math.round(amount * 60_000);
  if (unit.startsWith("hr") || unit.startsWith("hour")) return Math.round(amount * 60 * 60_000);
  return null;
}

function normalizeReminderBody(rawBody: string, fullInput: string): string {
  const body = rawBody
    .replace(/[.?!]+$/g, "")
    .replace(/^(?:please\s+)?(?:that\s+)?/i, "")
    .trim();
  if (body) {
    return body;
  }
  if (/\bcheck\s+back\b/i.test(fullInput)) {
    return "check back";
  }
  if (/\bupdate\b/i.test(fullInput)) {
    return "give me an update";
  }
  return "follow up";
}

function titleFromReminderBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 42) {
    return normalized;
  }
  return `${normalized.slice(0, 39).trim()}...`;
}
