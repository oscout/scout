/**
 * What you can actually do to one machine on the Network page.
 *
 * Built as a plain list so the menus that render it — the row button, the
 * keyboard menu, the right-click menu — all offer the same thing, and so the
 * rule that matters can be checked: every entry here does something. An action
 * that would no-op for this machine (copying an address it does not publish,
 * clearing a position it never had) is left out rather than shown greyed or,
 * worse, shown live and doing nothing.
 */

export type NodeMenuAction = {
  id: string;
  label: string;
  /** Shown as the item's title/description; keep it short. */
  hint?: string;
  /** Offered, but already under way — not an action that does nothing. */
  disabled?: boolean;
  run: () => void | Promise<void>;
};

export type NodeMenuContext = {
  machineId: string;
  machineLabel: string;
  /** Announced node id; `null` for a tailnet device with no node record. */
  nodeId: string | null;
  brokerUrl: string | null;
  /** This machine is currently filtered out of the map/rail. */
  hidden: boolean;
  /** Some machine is hidden, so "show all" would change something. */
  anyHidden: boolean;
  /** This machine has a dragged position that could be cleared. */
  positioned: boolean;
  /** The browser exposes a clipboard we may write to. */
  canCopy: boolean;
  /** A check for this machine is already running. */
  checking: boolean;
  on: {
    select: (machineId: string) => void;
    refresh: (machineId: string) => void;
    focus: (machineId: string) => void;
    toggleHidden: (machineId: string) => void;
    showAll: () => void;
    clearPosition?: (machineId: string) => void;
    copy: (text: string) => void;
  };
};

export function buildNodeMenuActions(context: NodeMenuContext): NodeMenuAction[] {
  const { machineId, on } = context;
  const actions: NodeMenuAction[] = [
    {
      id: "open",
      label: "Show what's running here",
      hint: "Load this machine's current agents and activity",
      run: () => on.select(machineId),
    },
    {
      id: "refresh",
      // Every published machine can be re-checked, including a tailnet device
      // with no broker: the check itself is the answer in that case.
      label: context.checking ? "Checking…" : "Refresh this node",
      hint: "Check reachability and re-read state now",
      disabled: context.checking,
      run: () => on.refresh(machineId),
    },
    {
      id: "focus",
      label: `Focus on ${context.machineLabel}`,
      hint: "Show only this machine",
      run: () => on.focus(machineId),
    },
    {
      id: "visibility",
      label: context.hidden ? "Show this machine" : "Hide this machine",
      run: () => on.toggleHidden(machineId),
    },
  ];

  if (context.anyHidden) {
    actions.push({ id: "show-all", label: "Show all machines", run: () => on.showAll() });
  }
  if (context.positioned && on.clearPosition) {
    actions.push({
      id: "clear-position",
      label: "Reset position",
      hint: "Put this machine back in the automatic layout",
      run: () => on.clearPosition?.(machineId),
    });
  }
  if (context.canCopy && context.nodeId) {
    actions.push({ id: "copy-node-id", label: "Copy node ID", run: () => on.copy(context.nodeId!) });
  }
  if (context.canCopy && context.brokerUrl) {
    actions.push({
      id: "copy-broker-url",
      label: "Copy broker address",
      run: () => on.copy(context.brokerUrl!),
    });
  }
  return actions;
}
