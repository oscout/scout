import { useEffect } from "react";
import { applyEmbedDocumentTitle } from "./embed-document-title.ts";

/** Sets `document.title` for native embed chrome; restores on change/unmount. */
export function useEmbedHeadline(title: string | null | undefined, enabled: boolean): void {
  useEffect(() => applyEmbedDocumentTitle(title, enabled), [title, enabled]);
}
