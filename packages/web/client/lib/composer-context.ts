/**
 * Page context a new task can carry: where the operator was when they opened
 * the composer, and — only if they say so — what they had selected.
 *
 * Sibling to `forward-context.ts`, which quotes a *Scout conversation*. This
 * one describes the *page*, so the two compose rather than compete: a forwarded
 * task states its source turns, a page-context task states its origin route.
 *
 * Everything here is Scout-visible material the operator can see on screen
 * before they send. Nothing is inferred, summarised, or captured in the
 * background.
 */

/** One labelled fact about where the task came from. */
export type ComposerContextItem = {
  label: string;
  value: string;
};

/**
 * Selection is capped rather than truncated silently at send time, so what the
 * composer shows is exactly what goes out. 1,200 characters is roughly a long
 * paragraph — enough to carry a stack trace or an error block, short enough
 * that it reads as a quote rather than a dump.
 */
export const MAX_CONTEXT_SELECTION_CHARS = 1_200;

/** Labels rendered inline; everything else is block-quoted. */
const INLINE_LABELS = new Set(["Page", "URL"]);

export function boundedSelection(raw: string): string {
  return raw.trim().slice(0, MAX_CONTEXT_SELECTION_CHARS);
}

/**
 * Build the context block for a route the operator opened the composer from.
 *
 * `selection` is passed in rather than read from the DOM: capture is an
 * explicit act at the call site, never an ambient listener. A composer that
 * quietly harvested `selectionchange` would attach whatever you last
 * highlighted anywhere in the app — including in another conversation — to a
 * message you never inspected.
 */
export function buildComposerContext(input: {
  pageTitle?: string;
  pageUrl?: string;
  selection?: string;
  notes?: string[];
}): ComposerContextItem[] {
  const items: ComposerContextItem[] = [
    { label: "Page", value: input.pageTitle ?? "" },
    { label: "URL", value: input.pageUrl ?? "" },
  ];
  if (input.selection?.trim()) {
    items.push({ label: "Selection", value: boundedSelection(input.selection) });
  }
  (input.notes ?? []).forEach((note, index) => {
    items.push({ label: `Note ${index + 1}`, value: note });
  });
  return items.filter((item) => item.value.trim());
}

/**
 * Render context above the operator's message.
 *
 * Context leads and the message closes, because the message is the instruction
 * and an agent reading top-down should reach it last, with the setting already
 * established. Empty values drop out entirely — a `URL:` line with nothing
 * after it is worse than no line.
 */
export function formatComposerContextBody(
  message: string,
  context: ComposerContextItem[],
): string {
  const parts: string[] = [];
  for (const item of context) {
    const value = item.value.trim();
    if (!value) continue;
    if (INLINE_LABELS.has(item.label)) {
      parts.push(`${item.label}: ${value}`);
    } else {
      parts.push(
        `${item.label}:\n${value.split("\n").map((line) => `> ${line}`).join("\n")}`,
      );
    }
  }
  const trimmedMessage = message.trim();
  if (trimmedMessage) parts.push(trimmedMessage);
  return parts.join("\n\n");
}
