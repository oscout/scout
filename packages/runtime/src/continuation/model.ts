/**
 * Cheap-model fallback for live dialogs the rules cannot parse.
 *
 * The model returns a structured guess. It does not send keys. The manager
 * maps the guess through the same policy as the rules and fail-closes on
 * low confidence, non-permission kinds, or a missing allow index.
 */

import {
  liveDialogMenuLines,
  parseContinuationDialog,
  stripTerminalControls,
  type ContinuationDialogKind,
} from "./dialog.js";
import {
  classifyContinuationRisk,
  continuationAllowsRisk,
  decideContinuation,
  type ContinuationRisk,
  type ContinuationVerdict,
} from "./decide.js";
import type { ContinuationLevel } from "./policy.js";

export const CONTINUATION_MODEL_ID = "grok-4.3";
const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 800;
const MAX_PANE_CHARS = 2_500;
const MAX_PANE_LINES = 40;

export type ContinuationModelGuess = {
  kind: ContinuationDialogKind;
  command: string | null;
  risk: ContinuationRisk;
  /** Numbered allow-once option. Never "don't ask again". */
  allowIndex: number | null;
  confidence: "high" | "low";
  reason: string;
};

export type ContinuationModel = (input: {
  paneBody: string;
  policy: ContinuationLevel;
}) => Promise<ContinuationModelGuess | null>;

const KINDS = new Set<ContinuationDialogKind>(["permission", "question", "plan", "hold", "unknown"]);
const RISKS = new Set<ContinuationRisk>([
  "workspace",
  "network",
  "publish",
  "destructive",
  "secrets",
  "identity",
  "unknown",
]);

export function needsContinuationModel(verdict: ContinuationVerdict): boolean {
  return verdict.live && verdict.source === "rules" && verdict.reason === "unparsed dialog";
}

function modelGuessMatchesPane(
  paneBody: string | undefined,
  command: string | null,
  allowIndex: number,
): boolean {
  if (paneBody === undefined || !command) return false;
  // The command must be the live dialog's whole command, as the rules read it.
  const dialog = parseContinuationDialog(paneBody);
  if (!dialog.live || !dialog.commandExact || !dialog.command) return false;
  if (dialog.command !== command.replace(/\s+/gu, " ").trim()) return false;
  // The allow option must be in the live dialog's own menu, once.
  const menu = liveDialogMenuLines(paneBody);
  if (!menu) return false;
  const option = new RegExp(`^\\s*[❯›]?\\s*${allowIndex}[.)]\\s+Yes\\b`, "u");
  const allowLines = menu.filter((line) => option.test(line));
  return allowLines.length === 1
    && !/don'?t ask again|always allow|auto mode/i.test(allowLines[0] ?? "");
}

export function applyContinuationModelGuess(
  rules: ContinuationVerdict,
  guess: ContinuationModelGuess | null,
  paneBody?: string,
): ContinuationVerdict {
  if (!guess || guess.confidence !== "high") {
    return {
      ...rules,
      source: "model",
      act: "notify",
      keys: null,
      reason: guess ? "model unsure" : "model unavailable",
    };
  }
  if (guess.kind !== "permission") {
    return {
      ...rules,
      kind: guess.kind,
      command: guess.command ?? rules.command,
      risk: guess.risk,
      source: "model",
      act: "notify",
      keys: null,
      reason: `model classified ${guess.kind}`,
    };
  }
  if (guess.allowIndex === null || !Number.isInteger(guess.allowIndex) || guess.allowIndex < 1) {
    return {
      ...rules,
      kind: "permission",
      command: guess.command ?? rules.command,
      risk: guess.risk,
      source: "model",
      act: "notify",
      keys: null,
      reason: "model had no allow option",
    };
  }
  const command = guess.command ?? rules.command;
  // The model only points at what is on screen: its command and its allow
  // option must both be visible in the dialog, or nothing continues.
  if (!modelGuessMatchesPane(paneBody, command, guess.allowIndex)) {
    return {
      ...rules,
      kind: "permission",
      command,
      risk: "unknown",
      source: "model",
      act: "notify",
      keys: null,
      reason: "model guess not on screen",
    };
  }
  // The model names the command; the rules still judge it. A model's
  // "workspace" never clears a command the rules would not.
  const ruleRisk = classifyContinuationRisk(command);
  const risk = ruleRisk === "workspace" && guess.risk !== "workspace" ? guess.risk : ruleRisk;
  if (!continuationAllowsRisk(rules.policy, risk)) {
    return {
      ...rules,
      kind: "permission",
      command,
      risk,
      source: "model",
      act: "notify",
      keys: null,
      reason: `${rules.policy} does not auto-continue ${risk}`,
    };
  }
  return {
    ...rules,
    kind: "permission",
    command,
    risk,
    source: "model",
    act: "continue",
    keys: [String(guess.allowIndex)],
    reason: `model: ${rules.policy} continues ${risk}`,
  };
}

export async function decideContinuationWithModel(input: {
  paneBody: string;
  policy?: ContinuationLevel | null;
  model?: ContinuationModel | null;
}): Promise<ContinuationVerdict> {
  const rules = decideContinuation({ paneBody: input.paneBody, policy: input.policy });
  if (!input.model || !needsContinuationModel(rules)) return rules;
  try {
    const guess = await input.model({ paneBody: input.paneBody, policy: rules.policy });
    return applyContinuationModelGuess(rules, guess, input.paneBody);
  } catch {
    return applyContinuationModelGuess(rules, null);
  }
}

export function parseContinuationModelGuess(raw: unknown): ContinuationModelGuess | null {
  const value = typeof raw === "string" ? parseJsonObject(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const risk = record.risk;
  const confidence = record.confidence;
  if (typeof kind !== "string" || !KINDS.has(kind as ContinuationDialogKind)) return null;
  if (typeof risk !== "string" || !RISKS.has(risk as ContinuationRisk)) return null;
  if (confidence !== "high" && confidence !== "low") return null;
  const allowIndex = record.allowIndex === null || record.allowIndex === undefined
    ? null
    : typeof record.allowIndex === "number" && Number.isInteger(record.allowIndex)
      ? record.allowIndex
      : null;
  if (record.allowIndex !== undefined && record.allowIndex !== null && allowIndex === null) {
    return null;
  }
  return {
    kind: kind as ContinuationDialogKind,
    command: typeof record.command === "string" && record.command.trim()
      ? record.command.trim().slice(0, 500)
      : null,
    risk: risk as ContinuationRisk,
    allowIndex,
    confidence,
    reason: typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim().slice(0, 200)
      : "model",
  };
}

export function continuationModelPrompt(paneBody: string): string {
  const lines = stripTerminalControls(paneBody).split(/\n/u);
  const clipped = lines.slice(Math.max(0, lines.length - MAX_PANE_LINES)).join("\n");
  return clipped.length > MAX_PANE_CHARS ? clipped.slice(-MAX_PANE_CHARS) : clipped;
}

const SYSTEM_PROMPT = [
  "Classify a coding-agent terminal dialog. Reply with JSON only:",
  '{"kind":"permission|question|plan|hold|unknown","command":string|null,"risk":"workspace|network|publish|destructive|secrets|identity|unknown","allowIndex":number|null,"confidence":"high|low","reason":string}',
  "kind=permission only for a Yes/No tool approval, not a question or plan.",
  "allowIndex is the numbered allow-once option (Yes). Never pick don't-ask-again or always-allow.",
  "risk=workspace for local tests/builds/edits. network for curl/http. publish for git push. destructive for rm -r/sudo. secrets for .env/keys.",
  "If unsure, confidence=low and kind=unknown.",
].join(" ");

export function createXaiContinuationModel(options: {
  apiKey?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  model?: string;
} = {}): ContinuationModel | null {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY ?? process.env.SCOUT_XAI_API_KEY ?? null;
  if (!apiKey?.trim()) return null;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = options.model ?? CONTINUATION_MODEL_ID;
  return async ({ paneBody }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await fetchImpl(XAI_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 200,
          reasoning_effort: "none",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: continuationModelPrompt(paneBody) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      return parseContinuationModelGuess(payload.choices?.[0]?.message?.content ?? null);
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
