import { epochMs } from "@openscout/protocol";
import { recordInput, firstMetadataString } from "./web-flights.ts";

export function metadataTimestampMs(value: unknown): number | undefined {
  return epochMs(value) ?? undefined;
}

export function metadataStringValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return firstMetadataString(metadata?.[key]);
}

export function metadataBooleanValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return metadata?.[key] === true;
}

export function metadataStringArrayValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

export function metadataRecordArrayValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown>[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(recordInput).filter((entry): entry is Record<string, unknown> => Boolean(entry));
}
