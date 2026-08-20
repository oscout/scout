import { useMemo } from "react";
import { useScout } from "../../scout/Provider.tsx";
import { AgentLanesView } from "./AgentLanesView.tsx";
import { readAgentLaneSize } from "./agent-lane-size.ts";
import { readLaneDeckProfileId } from "./lane-deck.ts";

function readEmbedParam(name: string): string | null {
  const value = new URLSearchParams(window.location.search).get(name)?.trim();
  return value || null;
}

export function AgentLanesEmbedScreen() {
  const { agents, navigate } = useScout();
  const profileId = useMemo(() => readLaneDeckProfileId(), []);
  const laneSize = useMemo(() => readAgentLaneSize(), []);
  const filters = useMemo(
    () => ({
      harnessFilter: readEmbedParam("harness"),
      projectFilter: readEmbedParam("project"),
    }),
    [],
  );

  return (
    <div className="s-agent-lanes-embed" data-scout-theme>
      <AgentLanesView
        navigate={navigate}
        agents={agents}
        embedded
        profileId={profileId}
        laneSize={laneSize}
        harnessFilter={filters.harnessFilter}
        projectFilter={filters.projectFilter}
      />
    </div>
  );
}