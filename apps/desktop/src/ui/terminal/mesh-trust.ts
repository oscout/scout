import type { TrustedPeerRecord } from "@openscout/protocol";
import type { EnrollmentSessionSummary } from "@openscout/runtime";

import type {
  MeshEnrollmentHandshake,
} from "../../core/mesh/trust-service.ts";
import type { MeshTrustSection } from "../../core/mesh/service.ts";

/* ── Helpers ── */

function ago(ts: number | undefined): string {
  if (!ts) return "never";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Display shortening only — the full key ID remains the identity. */
export function shortKeyId(keyId: string): string {
  return keyId.length > 16 ? `${keyId.slice(0, 16)}…` : keyId;
}

export function formatSasWords(words: string[]): string {
  return words.join(" ");
}

/* ── Renderers ── */

export function renderMeshPeers(peers: TrustedPeerRecord[]): string {
  if (peers.length === 0) {
    return "No trusted peers. Run `scout mesh enroll <peer-url>` to enroll one.";
  }

  const lines: string[] = [];
  lines.push(`${peers.length} trusted peer${peers.length === 1 ? "" : "s"} (labels are unverified)`);
  for (const peer of peers) {
    lines.push(`  ${peer.label} — ${peer.tier}`);
    lines.push(`    Key ID: ${shortKeyId(peer.keyId)}`);
    lines.push(`    Fingerprint: ${peer.fingerprint}`);
    lines.push(`    Granted: ${ago(peer.grantedAt)} via ${peer.grantedVia}`);
    if (peer.lastSeenAt) {
      lines.push(`    Last seen: ${ago(peer.lastSeenAt)}`);
    }
  }
  return lines.join("\n");
}

export function renderMeshTrustSection(trust: MeshTrustSection): string {
  const lines: string[] = [];
  lines.push("Trust cone");
  if (!trust.available) {
    lines.push(`  unavailable — ${trust.error ?? "broker did not answer the trust routes"}`);
    return lines.join("\n");
  }
  lines.push(`  Key ID: ${trust.keyId ?? "unknown"}`);
  lines.push(`  Fingerprint: ${trust.fingerprint ?? "unknown"}`);
  lines.push(`  Gate: ${trust.gateMode ?? "unknown"}`);
  lines.push(`  Peers: ${trust.peerCount}`);
  if (trust.pendingEnrollments > 0) {
    lines.push(`  Pending enrollments: ${trust.pendingEnrollments} (see \`scout mesh enroll\`)`);
  }
  return lines.join("\n");
}

export function renderMeshEnrollmentSessions(sessions: EnrollmentSessionSummary[]): string {
  if (sessions.length === 0) {
    return [
      "No in-flight enrollments on this node.",
      "To enroll a peer from here, run `scout mesh enroll <peer-url>`.",
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push("In-flight enrollments (peers that began a handshake with this node):");
  for (const session of sessions) {
    lines.push(`  ${session.remoteCard.label} (${session.remoteCard.fingerprint}) — ${session.state}`);
    lines.push(`    Enrollment: ${session.id}`);
    lines.push(`    Key ID: ${shortKeyId(session.remoteCard.keyId)}`);
    lines.push(`    Expires: ${ago(session.expiresAt).replace(" ago", " from now")}`);
    if (session.sasWords) {
      lines.push(`    SAS words: ${formatSasWords(session.sasWords)}`);
    }
  }
  lines.push("");
  lines.push("Compare the words with the peer's screen, then approve:");
  lines.push("  scout mesh enroll --approve <enrollment-id> [--tier observe|control]");
  return lines.join("\n");
}

export function renderMeshEnrollmentWords(handshake: MeshEnrollmentHandshake): string {
  const lines: string[] = [];
  lines.push(`Enrollment handshake with ${handshake.remote.label} (${handshake.peerUrl})`);
  lines.push("");
  lines.push(`  SAS words: ${formatSasWords(handshake.words)}`);
  lines.push("");
  lines.push(`  This node:  ${handshake.local.label} — ${handshake.local.fingerprint}`);
  lines.push(`  Peer:       ${handshake.remote.label} — ${handshake.remote.fingerprint} (unverified label)`);
  lines.push("");
  lines.push("Compare these words with the peer's screen (`scout mesh enroll` on the other");
  lines.push("machine shows the same words). Only approve if they match exactly.");
  return lines.join("\n");
}

export function renderMeshPeerGrant(peer: TrustedPeerRecord, action: string): string {
  return [
    `${action}: ${peer.label} — ${peer.tier}`,
    `  Key ID: ${peer.keyId}`,
    `  Fingerprint: ${peer.fingerprint}`,
  ].join("\n");
}

export function renderMeshPeerRevoked(keyId: string): string {
  return [
    `Revoked peer ${shortKeyId(keyId)}.`,
    "Re-enrolling requires a fresh handshake and fresh operator approval on both sides.",
  ].join("\n");
}
