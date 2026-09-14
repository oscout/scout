import type { ScoutCommandContext } from "../context.ts";
import {
  annotateMachine,
  forgetMachine,
  loadMachine,
  loadMachines,
  runMachineScan,
} from "../../core/machines/service.ts";
import {
  renderMachineDetail,
  renderMachineForget,
  renderMachines,
} from "../../ui/terminal/machines.ts";

const MACHINES_HELP = `scout machines — The computers Scout can see (docs/eng/sco-104-machines.md)

A machine is a box, not a Scout node: tailnet peers, LAN neighbours, and
terminal hosts all land here whether or not they run Scout.

Subcommands:
  scout machines                 List the roster (cached, cheap)
  scout machines scan            Run a fresh pass now
  scout machines show <ref>      Full detail and the evidence behind it

Annotate (<ref> is an id, name, host name, or address):
  scout machines name <ref> <name>   Set the name you call it
  scout machines note <ref> <text>   Attach a note ("" clears it)
  scout machines pin <ref>           Never prune it, however long it is gone
  scout machines unpin <ref>
  scout machines forget <ref>        Drop the record (returns if still present)

Discovery is passive: mDNS adverts the network already broadcasts, plus the
local ARP table. Scout never sweeps or port-scans a subnet.
`;

function reference(context: ScoutCommandContext, args: string[], usage: string): string | null {
  const value = args[1]?.trim();
  if (!value) {
    context.stderr(`Usage: ${usage}`);
    return null;
  }
  return value;
}

export async function runMachinesCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const subcommand = args[0] ?? "";

  switch (subcommand) {
    case "":
    case "list": {
      const report = await loadMachines();
      context.output.writeValue(report, renderMachines);
      return;
    }

    case "scan":
    case "refresh": {
      const report = await runMachineScan();
      context.output.writeValue(report, renderMachines);
      return;
    }

    case "show": {
      const ref = reference(context, args, "scout machines show <id|name|host|address>");
      if (!ref) return;
      const machine = await loadMachine(ref);
      context.output.writeValue(machine, renderMachineDetail);
      return;
    }

    case "name": {
      const ref = reference(context, args, "scout machines name <ref> <name>");
      if (!ref) return;
      // Everything after the reference, so `name mini the workshop mac` works
      // without quoting. An empty name reverts to the detected one.
      const name = args.slice(2).join(" ").trim();
      const machine = await annotateMachine(ref, { displayName: name.length > 0 ? name : null });
      context.output.writeValue(machine, renderMachineDetail);
      return;
    }

    case "note": {
      const ref = reference(context, args, "scout machines note <ref> <text>");
      if (!ref) return;
      const note = args.slice(2).join(" ").trim();
      const machine = await annotateMachine(ref, { notes: note.length > 0 ? note : null });
      context.output.writeValue(machine, renderMachineDetail);
      return;
    }

    case "pin":
    case "unpin": {
      const ref = reference(context, args, `scout machines ${subcommand} <ref>`);
      if (!ref) return;
      const machine = await annotateMachine(ref, { pinned: subcommand === "pin" });
      context.output.writeValue(machine, renderMachineDetail);
      return;
    }

    case "forget": {
      const ref = reference(context, args, "scout machines forget <ref>");
      if (!ref) return;
      const result = await forgetMachine(ref);
      context.output.writeValue({ reference: ref, ...result }, renderMachineForget);
      return;
    }

    case "help":
    case "--help":
    case "-h": {
      context.output.writeText(MACHINES_HELP);
      return;
    }

    default: {
      context.stderr(`Unknown machines subcommand: ${subcommand}`);
      context.output.writeText(MACHINES_HELP);
    }
  }
}
