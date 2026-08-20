declare const epochMsBrand: unique symbol;
declare const durationMsBrand: unique symbol;

export type EpochMs = number & { readonly [epochMsBrand]: "EpochMs" };
export type DurationMs = number & { readonly [durationMsBrand]: "DurationMs" };

export const EPOCH_MILLISECONDS_FLOOR = 1_000_000_000_000;

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function requireFinitePositive(value: number, label: string): number {
  if (!isFinitePositive(value)) {
    throw new RangeError(`${label} must be a finite positive number`);
  }

  return value;
}

export function nowMs(): EpochMs {
  return Date.now() as EpochMs;
}

export function epochMs(value: unknown): EpochMs | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : null;

  if (parsed === null || !isFinitePositive(parsed)) {
    return null;
  }

  return Math.trunc(parsed < EPOCH_MILLISECONDS_FLOOR ? parsed * 1000 : parsed) as EpochMs;
}

export function epochMsFromSeconds(value: number): EpochMs {
  return Math.trunc(requireFinitePositive(value, "Epoch seconds") * 1000) as EpochMs;
}

export function durationMs(value: number): DurationMs {
  return Math.trunc(requireFinitePositive(value, "Duration milliseconds")) as DurationMs;
}

export function toIso(ms: EpochMs): string {
  return new Date(ms).toISOString();
}
