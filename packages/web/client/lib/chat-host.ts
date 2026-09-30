import type { MachineRecord } from "@openscout/protocol";

export function hostApiPath(machineId: string | undefined, path: string): string {
  return machineId ? `/api/hosts/${encodeURIComponent(machineId)}${path}` : path;
}

/** Only a roster-advertised, non-loopback web endpoint can open a peer chat. */
export function hostChatUrl(machine: MachineRecord, conversationId: string): string | null {
  for (const evidence of machine.evidence) {
    if (evidence.kind !== "scout" || !evidence.webUrl) continue;
    try {
      const url = new URL(evidence.webUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
      if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname)) continue;
      url.pathname = `/c/${encodeURIComponent(conversationId)}`;
      url.search = "";
      url.hash = "";
      return url.href;
    } catch { /* Bad discovery evidence is not a navigable destination. */ }
  }
  return null;
}
