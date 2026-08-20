export const EPOCH_MILLISECONDS_FLOOR = 1_000_000_000_000;

function numericEpochValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function epochMs(value: unknown): number | undefined {
  const parsed = numericEpochValue(value);
  if (parsed === undefined) {
    return undefined;
  }
  return Math.trunc(parsed < EPOCH_MILLISECONDS_FLOOR ? parsed * 1000 : parsed);
}
