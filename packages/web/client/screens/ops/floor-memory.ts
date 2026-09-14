import type { AgentLane } from "./agent-lanes-model.ts";

/** Vacancies remain reserved until the operator explicitly compacts the floor. */
export function floorDeskOrder(previous: string[], incoming: string[]): string[] {
  return [...new Set([...previous, ...incoming])];
}

/** Only exact, unambiguous harness-session identities establish lineage. */
export function floorRelations(lanes: AgentLane[]): Array<{ parent: AgentLane; child: AgentLane }> {
  return lanes.flatMap((child) => {
    const ref = child.facts?.parentSessionId;
    if (!ref) return [];
    const parents = lanes.filter((lane) => lane.id !== child.id && lane.agent.harnessSessionId === ref);
    return parents.length === 1 ? [{ parent: parents[0], child }] : [];
  });
}
