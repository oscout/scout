/**
 * Terminal host capabilities and the pure selectors over them.
 *
 * Deliberately free of React and of `fetch`, so the rules a UI renders by can
 * be tested directly rather than through a component.
 */

export type TerminalHostControlAction =
  | "interrupt"
  | "quit"
  | "stop-job"
  | "restart-resume"
  | "detach"
  | "release"
  | "force-quit"
  | "force-quit-bridge";

export type TerminalHostCapabilities = {
  attach: boolean;
  relayAttach: boolean;
  observe: boolean;
  sendInput: boolean;
  capture: boolean;
  create: boolean;
  list: boolean;
  observedAgentState: boolean;
  control: TerminalHostControlAction[];
  harnessControl: TerminalHostControlAction[];
};

export type TerminalHostDescriptor = {
  id: string;
  label: string;
  description: string;
  capabilities: TerminalHostCapabilities;
  availability: { installed: boolean; version?: string | null; reason?: string | null };
};

export type TerminalHostsPayload = {
  ok: true;
  count: number;
  preferredHostId: string | null;
  hosts: TerminalHostDescriptor[];
};

/**
 * Whether a host performs a control verb, by either route.
 *
 * The default when the inventory has not loaded is FALSE: an action the server
 * would reject must not be drawn on the strength of an optimistic guess. A
 * button that appears a beat late is better than one that fails after a click.
 */
export function terminalHostSupportsControl(
  hosts: readonly TerminalHostDescriptor[],
  backend: string | null | undefined,
  action: TerminalHostControlAction,
): boolean {
  const host = hosts.find((candidate) => candidate.id === backend);
  if (!host) return false;
  return host.capabilities.control.includes(action)
    || host.capabilities.harnessControl.includes(action);
}

export function terminalHostById(
  hosts: readonly TerminalHostDescriptor[],
  backend: string | null | undefined,
): TerminalHostDescriptor | null {
  return hosts.find((candidate) => candidate.id === backend) ?? null;
}

export type TerminalStartOption = {
  value: string;
  label: string;
  detail: string;
  /** False when Scout can start it but the browser cannot render it in a tile. */
  relayAttach: boolean;
};

/**
 * What "start something new" may offer, derived from the host registry rather
 * than hardcoded.
 *
 * A host appears only when it is installed here AND declares it can create a
 * session headlessly, so a machine without zellij never sees a zellij button
 * and a herdr that is not installed never sees a herdr one. This is the
 * registry doing its job: adding a host is an adapter, not an edit to this
 * list. The plain shell is not a host — it is a disposable local PTY — so it
 * is always offered and always first.
 *
 * Hosts the browser can render come before hosts it cannot, so the option that
 * works here and now leads and the one that opens elsewhere is the deliberate
 * choice rather than the accidental first click.
 */
export function terminalStartOptions(
  hosts: readonly TerminalHostDescriptor[],
): TerminalStartOption[] {
  return [
    { value: "pty", label: "Shell", detail: "Disposable local shell", relayAttach: true },
    ...hosts
      .filter((host) => host.availability.installed && host.capabilities.create)
      .map((host) => ({
        value: host.id,
        label: host.label,
        detail: host.description,
        relayAttach: host.capabilities.relayAttach,
      }))
      .sort((left, right) =>
        Number(right.relayAttach) - Number(left.relayAttach) || left.value.localeCompare(right.value)
      ),
  ];
}
