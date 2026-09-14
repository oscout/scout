import { useCallback, useMemo } from "react";
import { updateLocation, useBrowserLocation } from "../../lib/router.ts";
import type { Route, SessionEntry } from "../../lib/types.ts";
import { useConversationList } from "../../lib/use-conversation-list.ts";
import { sessionMatchesConversationId } from "./agent-master-model.ts";
import {
  BESIDE_PARAM,
  besideAdd,
  besideFromRoute,
  besideRemove,
  besideRoute,
  besideToggle,
} from "./comms-deck.ts";

function besideNow(): string[] {
  if (typeof window === "undefined") return [];
  return besideFromRoute(new URLSearchParams(window.location.search).get(BESIDE_PARAM));
}

/**
 * The conversations kept beside the stage.
 *
 * The URL is the state: `?open=` is read from the location store and written
 * back through it, so the rail, the stage header and the columns themselves
 * all see one list, and a link carries it. `open` is a sticky key on Comms
 * paths (scope/paths.ts), which is what lets it survive navigating from one
 * conversation to the next — the whole point of keeping something beside.
 */
export function useBeside() {
  const { searchStr } = useBrowserLocation();
  const ids = useMemo(
    () => besideFromRoute(new URLSearchParams(searchStr).get(BESIDE_PARAM)),
    [searchStr],
  );
  const write = useCallback((next: readonly string[]) => {
    updateLocation({ searchPatch: { [BESIDE_PARAM]: next.length > 0 ? besideRoute(next) : null } });
  }, []);
  // Each write starts from the URL as it is now, not as it was rendered, so
  // two changes in one tick cannot undo each other.
  const add = useCallback((id: string) => write(besideAdd(besideNow(), id)), [write]);
  const remove = useCallback((id: string) => write(besideRemove(besideNow(), id)), [write]);
  const toggle = useCallback((id: string) => write(besideToggle(besideNow(), id)), [write]);
  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { ids, has, add, remove, toggle };
}

/**
 * Where a conversation goes when it is put on the stage.
 *
 * A conversation that belongs to an agent opens on that agent's surface with
 * the conversation as its thread, so the strip and the drawings around it stay
 * in view. Any other opens on its own page.
 */
export function stageRoute(
  conversationId: string,
  session: SessionEntry | undefined,
  machineId?: string,
): Route {
  const scope = machineId ? { machineId } : {};
  if (session?.agentId) {
    return { view: "messages", agentId: session.agentId, threadId: conversationId, ...scope };
  }
  return { view: "messages", conversationId, ...scope };
}

/** Put a conversation on the stage, wherever its stage is (see stageRoute). */
export function useStage(navigate: (route: Route) => void, machineId?: string) {
  const { sessions } = useConversationList();
  return useCallback((conversationId: string) => {
    navigate(stageRoute(
      conversationId,
      sessions.find((entry) => sessionMatchesConversationId(entry, conversationId)),
      machineId,
    ));
  }, [navigate, sessions, machineId]);
}
