/**
 * Default-deny secret redaction registry.
 *
 * Two incidents (2026-08-04, see docs/eng/secret-redaction-brief.md) showed
 * that resolved credentials reach agent transcripts, logs, and UI payloads
 * because nothing downstream knows which strings are secret. Name-heuristic
 * redaction fails exactly on the variables nobody thought to mark (a GitHub
 * PAT lived in a var named `GH`). This module flips the direction: every
 * credential resolver REGISTERS the exact string it resolved, and every
 * log/tail/persistence boundary scrubs registered strings out of the text
 * it emits. Sensitivity attaches to the value's provenance, not its name.
 *
 * Registration sources:
 * - credential resolvers (keychain/`secret` CLI, env bridging) at the moment
 *   they resolve a value;
 * - the varlock env graph at daemon boot — anything marked sensitive in
 *   `.env.schema` or produced by a resolver function (`exec()`, `keychain()`,
 *   `varlock()`), regardless of decorators.
 *
 * Scrubbing sinks: tail events, flight records, raw harness stdout/stderr
 * log appends, stderr-derived error messages, providerMeta, and (optionally)
 * console.* via `patchConsoleForSecrets()`.
 */

const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Below this length a registered string is ignored: short tokens cause
 * false-positive scrubbing of ordinary prose (and no real credential a
 * resolver returns should be shorter).
 */
const MIN_SECRET_LENGTH = 8;

const secretValues = new Set<string>();
const secretSources = new Map<string, string>();
let redactionRegex: RegExp | null = null;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rebuildRedactionRegex(): void {
  if (secretValues.size === 0) {
    redactionRegex = null;
    return;
  }
  // Longest-first so a registered value that is a prefix of another still
  // redacts the longer occurrence in a single pass.
  const alternation = [...secretValues].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  redactionRegex = new RegExp(alternation, "g");
}

/**
 * Register a resolved credential string. Called by credential resolvers —
 * anything that comes out of a keychain/`secret` CLI/env bridging path is
 * sensitive by definition, regardless of the variable name it came from.
 * `source` is a debug label (e.g. "opencode-acp:keychain"), never logged
 * with the value.
 */
export function registerSecretValue(value: string | null | undefined, source?: string): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  if (secretValues.has(trimmed)) return;
  secretValues.add(trimmed);
  if (source) secretSources.set(trimmed, source);
  rebuildRedactionRegex();
}

export function registerSecretValues(
  values: Iterable<string | null | undefined>,
  source?: string,
): void {
  for (const value of values) {
    registerSecretValue(value, source);
  }
}

/** Replace every registered secret in `text` with the placeholder. */
export function redactSecrets(text: string): string {
  if (!text || !redactionRegex) return text;
  redactionRegex.lastIndex = 0;
  return text.replace(redactionRegex, REDACTION_PLACEHOLDER);
}

/**
 * Deep variant for structured payloads (tail event `raw`, metadata): redacts
 * string values inside arrays and plain objects. Non-plain objects pass
 * through untouched.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (!redactionRegex || value == null) return value;
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsDeep(entry)) as T;
  }
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecretsDeep(entry);
    }
    return out as T;
  }
  return value;
}

/** Number of registered secret strings (diagnostics/tests only). */
export function registeredSecretCount(): number {
  return secretValues.size;
}

/** Debug labels for registered secrets, without the values themselves. */
export function registeredSecretSources(): string[] {
  return [...new Set(secretSources.values())].sort();
}

/** Test-only escape hatch: clears the registry. Never call in production. */
export function resetSecretRegistryForTests(): void {
  secretValues.clear();
  secretSources.clear();
  redactionRegex = null;
}

// ---------------------------------------------------------------------------
// console.* patch
// ---------------------------------------------------------------------------

const CONSOLE_METHODS = ["trace", "debug", "info", "log", "warn", "error"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

const originalConsoleMethods = new Map<ConsoleMethod, (...args: unknown[]) => void>();

function redactConsoleArgument(argument: unknown): unknown {
  if (typeof argument === "string") return redactSecrets(argument);
  if (argument instanceof Error) {
    const redacted = new Error(redactSecrets(argument.message));
    redacted.name = argument.name;
    if (argument.stack) redacted.stack = redactSecrets(argument.stack);
    return redacted;
  }
  return argument;
}

/**
 * Patch console.* so every string (and Error message/stack) logged by this
 * process is scrubbed against the registry first. This covers the broker
 * daemon's stdout/stderr log files, which capture plain console output.
 * Idempotent; `unpatchConsoleForSecrets` restores the originals.
 *
 * Known limit: process.stdout.write / process.stderr.write bypass console —
 * scrub those writes at their call sites instead.
 */
export function patchConsoleForSecrets(): void {
  for (const method of CONSOLE_METHODS) {
    if (originalConsoleMethods.has(method)) continue;
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    originalConsoleMethods.set(method, original);
    console[method] = (...args: unknown[]) => {
      original(...args.map(redactConsoleArgument));
    };
  }
}

export function unpatchConsoleForSecrets(): void {
  for (const [method, original] of originalConsoleMethods) {
    console[method] = original;
  }
  originalConsoleMethods.clear();
}
