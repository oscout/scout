import { api } from "./api.ts";
import type { ScoutbotUiAction } from "./scoutbot.ts";

/**
 * Runs page actions from always-on voice replies ("take me to the homepage").
 * The reply is made in the web server with no page attached, so every visible
 * page listens and the first to claim a batch runs it; hidden pages don't
 * listen, so a background tab never jumps.
 */

type AmbientPageActions = { id: string; at: number; actions: ScoutbotUiAction[] };

export function listenForAmbientPageActions(apply: (action: ScoutbotUiAction) => void): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => undefined;
  let source: EventSource | null = null;

  const onActions = (event: MessageEvent<string>) => {
    let batch: AmbientPageActions;
    try {
      batch = JSON.parse(event.data) as AmbientPageActions;
    } catch {
      return;
    }
    if (!batch?.id || !Array.isArray(batch.actions)) return;
    void api<{ claimed: boolean }>(`/api/voice/ambient/actions/${encodeURIComponent(batch.id)}/claim`, {
      method: "POST",
    }).then((result) => {
      if (!result.claimed) return;
      for (const action of batch.actions) apply(action);
    }).catch(() => {
      // Another page claimed it, or always-on is off.
    });
  };

  const sync = () => {
    const visible = document.visibilityState === "visible";
    if (visible && !source) {
      source = new EventSource("/api/voice/ambient/actions");
      source.addEventListener("actions", onActions as EventListener);
    } else if (!visible && source) {
      source.close();
      source = null;
    }
  };

  sync();
  document.addEventListener("visibilitychange", sync);
  return () => {
    document.removeEventListener("visibilitychange", sync);
    source?.close();
    source = null;
  };
}
