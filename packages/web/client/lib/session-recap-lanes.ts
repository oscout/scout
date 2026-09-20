import type { RecapLaneInput } from "./session-recap-identity.ts";

let lanes: RecapLaneInput[] = [];
let focusedId: string | null = null;
const listeners = new Set<() => void>();

export function publishRecapLanes(next: RecapLaneInput[]): void {
  lanes = next;
  for (const listener of listeners) listener();
}

export function getRecapLanes(): RecapLaneInput[] {
  return lanes;
}

export function subscribeRecapLanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishRecapFocus(next: string | null): void {
  focusedId = next;
}

export function getRecapFocus(): string | null {
  return focusedId;
}
