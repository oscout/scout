import { epochMs } from "@openscout/protocol";

export function normalizeUnixTimestamp(value: unknown): number | null {
  const ms = epochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

export function formatScoutTimestamp(timestamp: number): string {
  const value = new Date(timestamp * 1000);
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  const ss = String(value.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
