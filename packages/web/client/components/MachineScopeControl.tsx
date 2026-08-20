import { useEffect, useMemo, useRef, useState } from "react";
import { Server } from "lucide-react";
import { api } from "../lib/api.ts";
import {
  clearRouteMachineScope,
  routeMachineId,
  routeSupportsMachineScope,
  setRouteMachineScope,
} from "../lib/router.ts";
import { useScout } from "../scout/Provider.tsx";
import type { Agent, MeshStatus } from "../lib/types.ts";
import "./machine-scope-control.css";

type MachineOption = {
  id: string;
  label: string;
  group: "local" | "mesh" | "agent" | "selected";
};

function shortHost(value?: string | null): string {
  if (!value) return "";
  return value.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].split(".")[0] || value;
}

function machineLabel(node: { name?: string | null; hostName?: string | null } | null | undefined): string {
  return shortHost(node?.hostName) || node?.name || "machine";
}

function addOption(
  options: Map<string, MachineOption>,
  id: string | null | undefined,
  label: string | null | undefined,
  group: MachineOption["group"],
): void {
  const value = id?.trim();
  if (!value || options.has(value)) return;
  options.set(value, { id: value, label: label?.trim() || value, group });
}

function buildMachineOptions(mesh: MeshStatus | null, agents: Agent[], selectedMachineId: string | null): MachineOption[] {
  const options = new Map<string, MachineOption>();

  if (mesh?.localNode?.id) {
    addOption(options, mesh.localNode.id, machineLabel(mesh.localNode), "local");
  }

  for (const node of Object.values(mesh?.nodes ?? {})) {
    addOption(options, node.id, machineLabel(node), node.id === mesh?.localNode?.id ? "local" : "mesh");
  }

  for (const agent of agents) {
    addOption(options, agent.authorityNodeId, agent.authorityNodeName ?? agent.authorityNodeId, "agent");
    addOption(options, agent.homeNodeId, agent.homeNodeName ?? agent.homeNodeId, "agent");
  }

  if (selectedMachineId) {
    addOption(options, selectedMachineId, selectedMachineId, "selected");
  }

  return Array.from(options.values()).sort((a, b) => {
    const ar = a.group === "local" ? 0 : a.group === "mesh" ? 1 : a.group === "agent" ? 2 : 3;
    const br = b.group === "local" ? 0 : b.group === "mesh" ? 1 : b.group === "agent" ? 2 : 3;
    if (ar !== br) return ar - br;
    return a.label.localeCompare(b.label);
  });
}

/**
 * Machine scope control.
 *
 * Variants:
 * - `bar` / `nav`: legacy top-bar select (full width label + select)
 * - `sidebar`: expanded sidebar footer select
 * - `rail`: 48px icon rail — Server icon opens a popover with the same select
 *   (SCO-085: bare select does not fit the rail; icon + popover is the chosen
 *   collapsed presentation — not omitted).
 *
 * Exactly one instance must mount (sidebar footer XOR top bar). The select
 * always uses id `machine-scope-select`.
 */
export function MachineScopeControl({
  variant = "bar",
}: {
  variant?: "bar" | "nav" | "sidebar" | "rail";
}) {
  const { route, navigate, agents } = useScout();
  const [mesh, setMesh] = useState<MeshStatus | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const selectedMachineId = routeMachineId(route);

  useEffect(() => {
    if (!routeSupportsMachineScope(route)) return;
    let cancelled = false;
    api<MeshStatus>("/api/mesh")
      .then((data) => {
        if (!cancelled) setMesh(data);
      })
      .catch(() => {
        if (!cancelled) setMesh(null);
      });
    return () => {
      cancelled = true;
    };
  }, [route.view]);

  useEffect(() => {
    if (!railOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!railRef.current?.contains(event.target as Node)) {
        setRailOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [railOpen]);

  const options = useMemo(
    () => buildMachineOptions(mesh, agents, selectedMachineId),
    [agents, mesh, selectedMachineId],
  );

  if (!routeSupportsMachineScope(route)) return null;

  const selectedLabel = selectedMachineId
    ? (options.find((o) => o.id === selectedMachineId)?.label ?? selectedMachineId)
    : "All machines";

  const select = (
    <select
      id="machine-scope-select"
      className="machine-scope-select"
      value={selectedMachineId ?? ""}
      onChange={(event) => {
        const value = event.currentTarget.value;
        navigate(value ? setRouteMachineScope(route, value) : clearRouteMachineScope(route));
        setRailOpen(false);
      }}
      title={selectedLabel}
    >
      <option value="">All machines</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.group === "local" ? `${option.label} (this machine)` : option.label}
        </option>
      ))}
    </select>
  );

  if (variant === "rail") {
    return (
      <div className="machine-scope machine-scope--rail" ref={railRef}>
        <button
          type="button"
          className="machine-scope-rail-trigger"
          aria-label={`Machine scope: ${selectedLabel}`}
          title={`Machine scope: ${selectedLabel}`}
          aria-expanded={railOpen}
          onClick={() => setRailOpen((open) => !open)}
        >
          <Server size={16} strokeWidth={1.6} aria-hidden />
        </button>
        {railOpen ? (
          <div className="machine-scope-rail-popover" role="dialog" aria-label="Machine scope">
            <label className="machine-scope-label" htmlFor="machine-scope-select">
              Scope
            </label>
            {select}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`machine-scope machine-scope--${variant}`}>
      <label className="machine-scope-label" htmlFor="machine-scope-select">
        Scope
      </label>
      {select}
    </div>
  );
}
