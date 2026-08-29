import { AGENT_HARNESSES, type AgentHarness } from "@openscout/protocol";

const KNOWN_HARNESSES = new Set<string>(AGENT_HARNESSES);

export type ParsedSessionRouteRef = {
  refId: string;
  harness: AgentHarness | null;
  qualified: boolean;
};

export function canonicalSessionHarness(value: string | null | undefined): AgentHarness | null {
  const normalized = value?.trim().toLowerCase().replace(/_/gu, "-") ?? "";
  const alias = normalized === "claude-code" || normalized === "claude-stream-json"
    ? "claude"
    : normalized === "codex-app-server" || normalized === "codex-exec"
      ? "codex"
      : normalized === "pi-rpc"
        ? "pi"
        : normalized;
  return KNOWN_HARNESSES.has(alias) ? alias as AgentHarness : null;
}

export function normalizeNativeSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

export function parseSessionRouteRef(value: string | null | undefined): ParsedSessionRouteRef | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("session:")) {
    const remainder = trimmed.slice("session:".length);
    const separator = remainder.indexOf(":");
    if (separator > 0) {
      const harness = canonicalSessionHarness(remainder.slice(0, separator));
      const refId = normalizeNativeSessionRef(remainder.slice(separator + 1));
      if (harness && refId) return { refId, harness, qualified: true };
    }
    const legacyRef = normalizeNativeSessionRef(remainder);
    return legacyRef ? { refId: legacyRef, harness: null, qualified: false } : null;
  }
  const refId = normalizeNativeSessionRef(trimmed);
  return refId ? { refId, harness: null, qualified: false } : null;
}

export function formatSessionRouteRef(
  harnessValue: string | null | undefined,
  refValue: string | null | undefined,
): string | null {
  const parsed = parseSessionRouteRef(refValue);
  if (!parsed) return null;
  if (parsed.qualified) return `session:${parsed.harness}:${parsed.refId}`;
  const harness = canonicalSessionHarness(harnessValue);
  return harness ? `session:${harness}:${parsed.refId}` : parsed.refId;
}

export function sessionHarnessMatches(
  requested: string | null | undefined,
  observed: string | null | undefined,
): boolean {
  const requestedHarness = canonicalSessionHarness(requested);
  if (!requestedHarness) return true;
  return canonicalSessionHarness(observed) === requestedHarness;
}
