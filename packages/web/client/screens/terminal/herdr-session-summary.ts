import type { HerdrSessionTopology } from "@openscout/protocol";

/** Count host objects, not distinct harness names or tabs posing as workspaces. */
export function herdrSessionSummary(topology: HerdrSessionTopology): string {
  const tabs = topology.workspaces.flatMap((workspace) => workspace.tabs);
  const panes = tabs.flatMap((tab) => tab.panes);
  const counts = [
    [topology.workspaces.length, "workspace"],
    [tabs.length, "tab"],
    [panes.length, "pane"],
    [panes.filter((pane) => pane.agent).length, "agent"],
  ] as const;
  return counts.map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(" · ");
}
