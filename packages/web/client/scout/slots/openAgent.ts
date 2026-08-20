import {
  isSyntheticAgentId,
  sessionRefFromSyntheticAgent,
} from "../../lib/synthetic-agent-routing.ts";
import type { Agent, AgentTab, Route } from "../../lib/types.ts";
import type { NavigateOptions } from "../../lib/router.ts";
import { openContent } from "./openContent.ts";

/**
 * Where the open-agent call originated. Captured forward-looking for the
 * future content-pane swap (instantiate-and-dismiss inside the current shell);
 * also drives the agent-detail "back" affordance via `returnTo`.
 */
export type OpenAgentFrom =
  | "agents-tree"
  | "agents-rail"
  | "mesh-canvas"
  | "mesh-tree"
  | "fleet-map"
  | "messages"
  | "base-rail"
  | "inspector"
  | "home";

type OpenAgentOptions = {
  observe?: boolean;
  tab?: AgentTab;
  from?: OpenAgentFrom;
  /** Where the back/dismiss action on agent detail should return to. */
  returnTo?: Route;
};

export function openAgent(
  navigate: (route: Route, options?: NavigateOptions) => void,
  agent: Agent,
  options: OpenAgentOptions = {},
): void {
  if (isSyntheticAgentId(agent.id)) {
    const sessionId = sessionRefFromSyntheticAgent(agent);
    if (sessionId) {
      openContent(navigate, { view: "sessions", sessionId }, { returnTo: options.returnTo });
    }
    return;
  }
  const tab = options.tab ?? (options.observe ? "observe" : undefined);
  const target: Route = {
    view: "agents-v2",
    agentId: agent.id,
    ...(tab ? { tab } : {}),
  };
  if (options.returnTo) {
    navigate(target, { returnTo: options.returnTo });
    return;
  }
  navigate(target);
}
