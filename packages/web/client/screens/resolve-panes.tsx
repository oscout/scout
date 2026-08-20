import type { ReactNode } from "react";
import type { Route } from "../lib/types.ts";
import type { useScout } from "../scout/Provider.tsx";
import { ActivityContent } from "./activity/index.ts";
import { AgentsContent, AgentsLeft, AgentsRight } from "./agents/index.ts";
import { ProjectsRail, ProjectsScreen, ProjectsThreadAside } from "./projects/index.ts";
import { BriefingsContent } from "./briefings/index.ts";
import { BrokerContent } from "./broker/index.ts";
import { ChatContent, ChatLeft, ChatRight } from "./chat/index.ts";
import { CodeContent } from "./code/index.ts";
import { FollowContent } from "./follow/index.ts";
import { HarnessesContent } from "./harnesses/index.ts";
import { HomeContent, HomeLeft, HomeRight } from "./home/index.ts";
import { MeshContent, MeshLeft, MeshRight } from "./mesh/index.ts";
import { MeshOpsContent, MeshOpsLeft, MeshOpsRight } from "./mesh-ops/index.ts";
import { OpsContent, OpsLeft } from "./ops/index.ts";
import { ReposContent, ReposRight } from "./repos/index.ts";
import { SearchContent, SearchRight } from "./search/index.ts";
import { SessionsContent, SessionsRight } from "./sessions/index.ts";
import { SettingsContent } from "./settings/index.ts";
import { TerminalContent, TerminalLeft, TerminalRight } from "./terminal/index.ts";
import { WorkContent, WorkRight } from "./work/index.ts";
import { RealtimeVoicePage } from "./voice/RealtimeVoiceScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

/** Left pane for the current route. Falls back to HomeLeft when a surface has no custom left. */
export function resolveLeftPane(route: Route, navigate: Navigate): ReactNode {
  switch (route.view) {
    case "ops":
      return <OpsLeft />;
    case "agents-v2":
      return <ProjectsRail route={route} navigate={navigate} />;
    case "agent-info":
      return <AgentsLeft />;
    case "messages":
    case "conversation":
      return <ChatLeft />;
    case "mesh":
      return <MeshLeft />;
    case "mesh-ops":
      return <MeshOpsLeft />;
    case "terminal":
      return <TerminalLeft />;
    case "inbox":
    default:
      return <HomeLeft />;
  }
}

/** Center content for the current route. */
export function resolveContentPane(
  route: Route,
  navigate: Navigate,
  agents: ReturnType<typeof useScout>["agents"] = [],
): ReactNode {
  switch (route.view) {
    case "conversation":
    case "messages":
      return <ChatContent route={route} navigate={navigate} />;
    case "agents-v2":
      return <ProjectsScreen route={route} navigate={navigate} />;
    case "agent-info":
      return <AgentsContent route={route} navigate={navigate} />;
    case "settings":
      return <SettingsContent route={route} navigate={navigate} />;
    case "inbox":
      return <HomeContent navigate={navigate} />;
    case "sessions":
      return <SessionsContent route={route} navigate={navigate} />;
    case "search":
      return <SearchContent route={route} navigate={navigate} />;
    case "mesh":
      return <MeshContent route={route} navigate={navigate} />;
    case "mesh-ops":
      return <MeshOpsContent route={route} navigate={navigate} />;
    case "broker":
      return <BrokerContent route={route} navigate={navigate} />;
    case "code":
      return <CodeContent route={route} navigate={navigate} />;
    case "repos":
    case "repo-diff":
      return <ReposContent route={route} navigate={navigate} />;
    case "harnesses":
      return <HarnessesContent route={route} navigate={navigate} />;
    case "briefings":
      return <BriefingsContent route={route} navigate={navigate} />;
    case "activity":
      return <ActivityContent route={route} navigate={navigate} />;
    case "voice":
      return <RealtimeVoicePage />;
    case "ops":
      return <OpsContent route={route} navigate={navigate} />;
    case "terminal":
      return <TerminalContent route={route as Extract<Route, { view: "terminal" }>} navigate={navigate} />;
    case "work":
      return <WorkContent route={route} navigate={navigate} />;
    case "follow":
      return <FollowContent route={route} navigate={navigate} />;
    default:
      return <HomeContent navigate={navigate} />;
  }
}

/** Right pane for the current route, or null when the surface has no inspector. */
export function resolveRightPane(route: Route, navigate: Navigate): ReactNode {
  switch (route.view) {
    case "inbox":
      return <HomeRight />;
    case "agents-v2": {
      if (!route.agentId) {
        // Index mode: selected threads/sessions peek in the shell sidebar.
        return (route.selectedAgentId || route.sessionId)
          ? <ProjectsThreadAside route={route} navigate={navigate} />
          : null;
      }
      // Profile (agent-profile-rebalance): center = sessions spine + inline summary;
      // right rail = session snapshot, files, transcript tail, Observe/Take over.
      return <AgentsRight />;
    }
    case "agent-info":
      return <AgentsRight />;
    case "sessions":
      return route.flightId ? null : <SessionsRight />;
    case "search":
      return <SearchRight />;
    case "conversation":
      return <ChatRight />;
    case "messages":
      return <ChatRight />;
    case "terminal":
      return <TerminalRight />;
    case "work":
      return <WorkRight />;
    case "mesh":
      return <MeshRight />;
    case "mesh-ops":
      return <MeshOpsRight />;
    case "repos":
      return <ReposRight />;
    default:
      return null;
  }
}
