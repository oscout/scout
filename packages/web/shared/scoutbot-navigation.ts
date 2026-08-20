export type ScoutbotNavigationDestination = {
  id: string;
  label: string;
  description: string;
  route: Record<string, unknown>;
  deepActions?: string[];
};

export type ScoutbotUiContext = {
  host: "web" | "macos";
  shellLabel: string;
  destinations: ScoutbotNavigationDestination[];
  rules: string[];
};

/** Product vocabulary for the full web shell. Internal Route.view aliases are
 * intentionally absent: Scoutbot should speak in page names, then emit the
 * implementation route only inside its hidden scout-ui action. */
export const SCOUTBOT_WEB_DESTINATIONS: ScoutbotNavigationDestination[] = [
  { id: "home", label: "Home", description: "Fleet overview, briefings, and recent activity.", route: { view: "inbox" } },
  { id: "projects", label: "Projects", description: "Projects, agents, and project-scoped work.", route: { view: "agents-v2" }, deepActions: ["Open a project by projectSlug.", "Open an agent by agentId."] },
  { id: "sessions", label: "Sessions", description: "Active and recent harness sessions.", route: { view: "sessions" }, deepActions: ["Open a session by sessionId."] },
  { id: "messages", label: "Messages", description: "Direct conversations and channels.", route: { view: "messages" }, deepActions: ["Open a conversation by conversationId.", "Filter by all, direct messages, or channels."] },
  { id: "dispatch", label: "Dispatch", description: "Requests, flights, work, and delivery state.", route: { view: "broker" } },
  { id: "search", label: "Search", description: "Knowledge and indexed workspace search.", route: { view: "search" } },
  { id: "operations", label: "Operations", description: "Mission Control, live activity, agent lanes, runtime, and mesh health.", route: { view: "ops", mode: "mission" } },
  { id: "repositories", label: "Repositories", description: "Repository and worktree status, including diffs.", route: { view: "repos" }, deepActions: ["Open a repository by absolute root."] },
  { id: "code-browser", label: "Code Browser", description: "Read files in a project or worktree.", route: { view: "code" }, deepActions: ["Select a project with the project field; it accepts the displayed project name or slug.", "Open a file inside it with path and optional wt.", "Alternatively use absolute root and file fields.", "Focus a line with line and optional endLine.", "Deep links: scout://{project}/{path}, scout:///{absolute/path}, or legacy scout://code/{project}/{path}."] },
  { id: "terminals", label: "Terminals", description: "Observe or take over terminal sessions.", route: { view: "terminal" } },
  { id: "settings", label: "Settings", description: "Connections, agents, communications, credentials, voice, and devices.", route: { view: "settings" } },
];

/** Honest capabilities of the simplified native shell. Web-only pages are not
 * listed and therefore must never be advertised by hosted live voice. */
export const SCOUTBOT_MACOS_DESTINATIONS: ScoutbotNavigationDestination[] = [
  { id: "comms", label: "Comms", description: "Native conversations and channels.", route: { view: "messages" }, deepActions: ["Open a conversation by conversationId.", "Open a channel by channelId."] },
  { id: "projects", label: "Projects", description: "Native project and agent browser.", route: { view: "agents-v2" }, deepActions: ["Filter to a project by projectSlug.", "Select an agent by agentId."] },
  { id: "terminals", label: "Terminals", description: "Native terminal workspace.", route: { view: "terminal" }, deepActions: ["Select an agent terminal by agentId."] },
  { id: "tail", label: "Tail", description: "Live agent and harness activity.", route: { view: "ops", mode: "tail" } },
  { id: "dispatch", label: "Dispatch", description: "Dispatch and coordination overview.", route: { view: "broker" } },
  { id: "agent-lanes", label: "Agent Lanes", description: "Native lane overview for active agents.", route: { view: "ops", mode: "lanes" } },
  { id: "repositories", label: "Repositories", description: "Native repository and worktree status.", route: { view: "repos" } },
  { id: "code-browser", label: "Code Browser", description: "Embedded read-only project browser.", route: { view: "code" }, deepActions: ["Select a project with the project field; it accepts the displayed project name or slug.", "Open a file inside it with path and optional wt.", "Alternatively use absolute root and file fields.", "Focus a line with line and optional endLine.", "Deep links: scout://{project}/{path}, scout:///{absolute/path}, or legacy scout://code/{project}/{path}."] },
  { id: "settings", label: "Settings", description: "Native app settings; Voice is directly addressable.", route: { view: "settings" }, deepActions: ["Open Voice settings with section=voice."] },
];

export function scoutbotUiContext(host: "web" | "macos"): ScoutbotUiContext {
  const macos = host === "macos";
  return {
    host,
    shellLabel: macos ? "Scout for macOS" : "OpenScout web",
    destinations: macos ? SCOUTBOT_MACOS_DESTINATIONS : SCOUTBOT_WEB_DESTINATIONS,
    rules: [
      "When asked what navigation is available, list only these human labels and short descriptions.",
      "Never expose internal Route.view names, aliases, URL fragments, or implementation vocabulary in the human reply.",
      "Emit only a destination route or deep action explicitly described by this host context.",
      "If the requested destination or deep action is absent, say it is not available in this app instead of approximating it with another page.",
    ],
  };
}
