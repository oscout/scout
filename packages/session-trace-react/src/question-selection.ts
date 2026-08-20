import type { QuestionBlock } from "@openscout/session-trace";

export function toggleTraceQuestionSelection(
  selected: readonly string[],
  optionLabel: string,
): string[] {
  return selected.includes(optionLabel)
    ? selected.filter((label) => label !== optionLabel)
    : [...selected, optionLabel];
}

export function composeTraceQuestionAnswer(
  question: QuestionBlock,
  selected: readonly string[],
): string[] {
  const selectedLabels = new Set(selected);
  const orderedSelections = question.options
    .map((option: QuestionBlock["options"][number]) => option.label)
    .filter((label: string) => selectedLabels.has(label));

  if (!question.multiSelect) {
    return orderedSelections.slice(0, 1);
  }

  return orderedSelections;
}
