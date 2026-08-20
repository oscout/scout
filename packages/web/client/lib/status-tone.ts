import type {
  BrokerRouteAttempt,
  MeshStatus,
  PairingState,
  WorkDetail,
  WorkItem,
} from "./types.ts";

/**
 * Canonical tone enum for status pills and chips across the web client.
 *
 * Maps to CSS class families:
 *   - `s-pill-*`     (work-themed):  updated | working | completed | failed
 *   - `sys-chip-*`   (system-themed): neutral | warning | working | success | danger (= failed)
 *
 * Both families are rendered by `<StatusPill>` via `toneToPillClass()` /
 * `toneToChipClass()`. Centralizing the enum lets each screen think in semantic
 * terms (success/warning/etc.) instead of repeating ad-hoc string unions.
 */
export type Tone = "neutral" | "success" | "warning" | "danger" | "working";

/** Map a canonical tone to its `s-pill-*` variant class suffix. */
export function toneToPillClass(tone: Tone): "updated" | "working" | "completed" | "failed" {
  switch (tone) {
    case "success":
      return "completed";
    case "danger":
      return "failed";
    case "working":
      return "working";
    case "warning":
    case "neutral":
    default:
      return "updated";
  }
}

/** Map a canonical tone to its `sys-chip-*` variant class suffix. */
export function toneToChipClass(tone: Tone): "neutral" | "success" | "warning" | "danger" | "working" {
  return tone;
}

/* ------------------------------------------------------------------ */
/* Work items (WorkList, WorkDetailScreen)                            */
/* ------------------------------------------------------------------ */

/**
 * Map a work item / detail to a canonical tone.
 * Mirrors the legacy `pillVariant()` mapping but in canonical tone-space.
 *
 *   interrupt attention -> danger      (was: "failed")
 *   state === "done"    -> success     (was: "completed")
 *   badge / waiting / review -> warning (was: "updated")
 *   otherwise           -> working
 */
export function workTone(work: WorkItem | WorkDetail): Tone {
  if (work.attention === "interrupt") return "danger";
  if (work.state === "done") return "success";
  if (work.attention === "badge" || work.state === "waiting" || work.state === "review") {
    return "warning";
  }
  return "working";
}

/** Tone for a child work card on the work-detail screen. */
export function workChildTone(child: Pick<WorkItem, "attention">): Tone {
  return child.attention === "interrupt" ? "danger" : "warning";
}

/* ------------------------------------------------------------------ */
/* Broker (BrokerScreen)                                              */
/* ------------------------------------------------------------------ */

/** Tone for a broker route attempt row based on its kind + status. */
export function brokerAttemptTone(
  kind: BrokerRouteAttempt["kind"],
  status: string,
): Tone {
  if (kind === "success" || status === "sent" || status === "acknowledged" || status === "completed") {
    return "success";
  }
  if (
    kind === "failed_query" ||
    kind === "failed_delivery" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return "danger";
  }
  if (status === "running" || status === "accepted" || status === "deferred" || status === "pending") {
    return "working";
  }
  return "neutral";
}

/* ------------------------------------------------------------------ */
/* Mesh (MeshScreen, MeshInspector)                                   */
/* ------------------------------------------------------------------ */

/** Overall health tone for the mesh status pill. */
export function meshHealthTone(mesh: MeshStatus): Tone {
  if (!mesh.health.reachable) return "danger";
  if (mesh.issues.some((i) => i.severity === "error")) return "danger";
  if (mesh.issues.length > 0) return "warning";
  return "success";
}

/* ------------------------------------------------------------------ */
/* Settings (SettingsScreen)                                          */
/* ------------------------------------------------------------------ */

/** Tone for the pairing chip in settings. */
export function pairingTone(pairing: PairingState | null): Tone {
  if (!pairing) return "warning";
  if (pairing.status === "paired" || pairing.status === "connected") return "success";
  if (pairing.status === "error" || pairing.status === "closed") return "danger";
  return "warning";
}
