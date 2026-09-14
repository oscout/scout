import type { HerdrSessionTopology } from "@openscout/protocol";

/**
 * Flattening a herdr session into matchable text.
 *
 * Kept apart from the hook that fetches it so the shape of the text — the part
 * with the judgement calls in it — can be tested without a React runtime.
 */

/**
 * A desk carries its number alongside its name — "Mix desk 1" is what the
 * herdr client says and what the operator reads — unless the name IS the
 * number, which is all an unnamed desk has.
 */
function deskLabel(label: string | null, number: number | null): string {
  const name = label?.trim() ?? "";
  if (name && number != null && name !== String(number)) return `${name} ${number}`;
  if (name) return name;
  return number != null ? String(number) : "";
}

/**
 * A tab is the opposite: herdr numbers every tab, so appending the number to a
 * named one adds a digit to every line and distinguishes nothing. The name when
 * there is one, the number when there is not.
 */
function tabLabel(label: string | null, number: number | null): string {
  const name = label?.trim() ?? "";
  if (name && name !== String(number)) return name;
  return number != null ? String(number) : name;
}

/**
 * Flatten a topology into matchable text: one line per pane, each carrying the
 * desk and tab it sits in, its own title, the agent on it and how that agent is
 * doing. One line per pane so a quoted run cannot be assembled across two panes
 * that have nothing to do with each other, and so a hit can be shown as the
 * line it matched.
 */
export function herdrPaneSearchText(topology: HerdrSessionTopology): string {
  const lines: string[] = [];
  for (const workspace of topology.workspaces) {
    const desk = deskLabel(workspace.label, workspace.number);
    for (const tab of workspace.tabs) {
      const tabName = tabLabel(tab.label, tab.number);
      for (const pane of tab.panes) {
        const parts = [desk, tabName, pane.label?.trim() ?? "", pane.agent ?? ""]
          .map((part) => part.trim())
          .filter(Boolean);
        // A pane with no title and no agent is a bare shell; say so rather than
        // emitting a line that is only the desk it happens to sit in.
        if (!pane.label?.trim() && !pane.agent) parts.push("shell");
        if (pane.agent && pane.agentStatus !== "unknown") parts.push(pane.agentStatus);
        // A guillemet, not the interpunct herdr's own labels are full of
        // ("OpenScout · Grok + portal"): the excerpt has to show where the desk
        // ends and the tab begins, and a separator the data already uses cannot.
        lines.push(parts.join(" › "));
      }
    }
  }
  return lines.join("\n");
}
