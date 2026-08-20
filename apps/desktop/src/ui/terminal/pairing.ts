import type { ScoutPairingEvent, ScoutPairingReadyEvent, ScoutPairingStatusEvent } from "../../core/pairing/service.ts";

export function renderScoutPairingEvent(event: ScoutPairingEvent): string {
  if (event.type === "pairing_ready") {
    return renderScoutPairingReady(event);
  }
  return renderScoutPairingStatus(event);
}

export function renderScoutPairingReady(event: ScoutPairingReadyEvent): string {
  const expiresIn = Math.max(0, Math.round((event.payload.expiresAt - Date.now()) / 1000));
  const lines = [
    "Scout pair",
    "",
    event.qrArt,
    "",
    `relay: ${event.relay}`,
    `room: ${event.payload.room}`,
    `key: ${event.identityFingerprint}...`,
    `expires: ${expiresIn}s`,
    `trusted peers: ${event.trustedPeerCount}`,
  ];

  if (event.config.workspaceRoot) {
    lines.push(`workspace: ${event.config.workspaceRoot}`);
  }

  return lines.join("\n");
}

export function renderScoutPairingStatus(event: ScoutPairingStatusEvent): string {
  return event.detail ? `[${event.status}] ${event.detail}` : `[${event.status}]`;
}
