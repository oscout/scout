/** Applies an embed headline to `document.title`; returns cleanup when changed. */
export function applyEmbedDocumentTitle(
  title: string | null | undefined,
  enabled: boolean,
): (() => void) | undefined {
  if (typeof document === "undefined") return;
  if (!enabled) return;

  const trimmed = title?.trim();
  if (!trimmed) return;

  const previous = document.title;
  document.title = trimmed;

  return () => {
    document.title = previous;
  };
}
