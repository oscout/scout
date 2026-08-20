import type {
  HarnessEventNormalizer,
  HarnessEventNormalizerContext,
} from "../protocol/normalizer.js";
import { createClaudeCodeEventNormalizer } from "../adapters/claude-code/normalizer.js";
import { createCodexEventNormalizer } from "../adapters/codex/normalizer.js";
import { createEchoEventNormalizer } from "../adapters/echo/normalizer.js";
import { createOpenCodeV2EventNormalizer } from "../adapters/opencode-v2/normalizer.js";

export type NormalizerFactory = (
  context: HarnessEventNormalizerContext,
) => HarnessEventNormalizer;

const NORMALIZERS: Record<string, NormalizerFactory> = {
  echo: (context) => createEchoEventNormalizer(context),
  codex: (context) => createCodexEventNormalizer(context),
  "claude-code": (context) => createClaudeCodeEventNormalizer(context),
  "opencode-v2": (context) => createOpenCodeV2EventNormalizer(context),
};

export function resolveNormalizerFactory(normalizerId: string): NormalizerFactory | null {
  return NORMALIZERS[normalizerId] ?? null;
}

export function listKnownNormalizerIds(): string[] {
  return Object.keys(NORMALIZERS).sort();
}
