import type {
  AdapterBudgetObservationInput,
  AdapterBudgetObservations,
} from "../protocol/budget-observations.js";
import { readClaudeCodeBudgetObservations } from "./claude-code/usage.js";
import { readCodexBudgetObservations } from "./codex/usage.js";

function emptyObservations(): AdapterBudgetObservations {
  return {
    usage: [],
    quotaWindows: [],
  };
}

function adapterHint(input: AdapterBudgetObservationInput): string {
  return [
    input.harness,
    input.transport,
    input.adapterType,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function readAdapterBudgetObservations(
  input: AdapterBudgetObservationInput,
  now = Date.now(),
): AdapterBudgetObservations {
  const hint = adapterHint(input);
  if (hint.includes("codex")) {
    return readCodexBudgetObservations(input, now);
  }
  if (hint.includes("claude")) {
    return readClaudeCodeBudgetObservations(input, now);
  }
  return emptyObservations();
}
