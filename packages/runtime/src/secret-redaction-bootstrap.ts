/**
 * Boot-time population of the secret-redaction registry (see
 * docs/eng/secret-redaction-brief.md).
 *
 * Two layers, both default-deny:
 *
 * 1. The varlock env graph: anything `.env.schema` marks sensitive OR any
 *    value produced by a resolver function (`exec()`, `keychain()`,
 *    `varlock()`) is registered — provenance, not variable name. This is the
 *    layer that would have caught the `GH` PAT incident.
 * 2. Declared credential env vars (the same names harness-catalog readiness
 *    checks require): a launchd-started broker inherits keys in process.env
 *    that no resolver ever touches; register those exact declared names so
 *    their values are scrubbed too.
 *
 * Everything here is best-effort and never throws: redaction must not become
 * a boot dependency for the broker daemon. Varlock is used as a library
 * (`internal.loadEnvGraph`), not via a `varlock run` wrapper — pin the
 * version if the semi-private `internal` surface changes shape.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { secretEnvKeys } from "@openscout/agent-sessions/auth";
import {
  patchConsoleForSecrets,
  registerSecretValue,
  registeredSecretCount,
} from "@openscout/agent-sessions/secret-redaction";

/**
 * Credential variables Scout itself declares, derived from the harness auth
 * models rather than hand-maintained here.
 *
 * This list used to be written out by hand and drifted: it named
 * `ANTHROPIC_OAUTH_TOKEN` (from pi's provider map) but not
 * `CLAUDE_CODE_OAUTH_TOKEN`, which is the variable Claude Code actually reads
 * and the credential a cloud instance is most likely to hold. Deriving it
 * means a credential declared for readiness is redacted by construction — one
 * declaration, so the two cannot disagree again.
 *
 * Resolver-produced values are still registered at resolution time regardless
 * of name; this covers launchd-provided env values no resolver path reads.
 */
const ENVIRONMENT_CREDENTIAL_NAMES: readonly string[] = secretEnvKeys();

export interface SecretRedactionBootstrapResult {
  registered: number;
  schemaPath: string | null;
  varlockLoaded: boolean;
}

/** Walk up from `startDirectory` looking for a varlock `.env.schema`. */
export function findEnvSchemaPath(startDirectory: string): string | null {
  let directory = startDirectory;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(directory, ".env.schema");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

interface VarlockConfigItemLike {
  isSensitive?: boolean;
  resolvedEnvStringValue?: unknown;
  resolvedRawValue?: unknown;
  valueResolver?: { fnName?: string; def?: { impliesSensitive?: boolean } };
}

/**
 * Resolvers that fetch credentials from outside the file. Static/ref
 * resolvers are excluded: a `ref` to a public value is public, and static
 * values rely on decorators alone. `exec()` does not declare
 * `impliesSensitive` in varlock 1.16, so it must be named explicitly.
 */
const CREDENTIAL_RESOLVER_FNAMES: ReadonlySet<string> = new Set([
  "exec",
  "keychain",
  "varlock",
]);

function isCredentialResolver(item: VarlockConfigItemLike): boolean {
  const resolver = item.valueResolver;
  if (!resolver) return false;
  if (resolver.def?.impliesSensitive === true) return true;
  const fnName = (resolver.fnName ?? "").replace(/^\u0000/, "");
  return CREDENTIAL_RESOLVER_FNAMES.has(fnName);
}

/**
 * Register every sensitive (or resolver-produced) value from the varlock
 * env graph rooted at the given schema path. Returns the number of values
 * the graph contributed.
 */
export async function registerSecretsFromEnvSchema(schemaPath: string): Promise<number> {
  const before = registeredSecretCount();
  // Dynamic import: varlock is a heavy, optional dependency of broker boot.
  const { internal } = await import("varlock");
  const graph = await internal.loadEnvGraph({
    basePath: dirname(schemaPath),
    skipCache: true,
  });
  await graph.resolveEnvValues();
  const schema = graph.configSchema as Record<string, VarlockConfigItemLike>;
  for (const [key, item] of Object.entries(schema)) {
    // Default-deny: values produced by a credential resolver are sensitive
    // even if a decorator says otherwise (or forgot to say anything).
    const sensitive = item.isSensitive === true || isCredentialResolver(item);
    if (!sensitive) continue;
    const envString = typeof item.resolvedEnvStringValue === "string"
      ? item.resolvedEnvStringValue
      : undefined;
    registerSecretValue(envString, `varlock:${key}`);
    if (typeof item.resolvedRawValue === "string" && item.resolvedRawValue !== envString) {
      registerSecretValue(item.resolvedRawValue, `varlock:${key}`);
    }
  }
  return registeredSecretCount() - before;
}

export async function bootstrapSecretRedaction(options: {
  startDirectory?: string;
  env?: Record<string, string | undefined>;
  patchConsole?: boolean;
  schemaPath?: string | null;
  log?: (message: string) => void;
  /** Test seam: override the varlock graph load. */
  loadSecrets?: (schemaPath: string) => Promise<number>;
} = {}): Promise<SecretRedactionBootstrapResult> {
  const log = options.log ?? (() => undefined);
  if (options.patchConsole) {
    // Patch first: the patched console reads the registry at call time, so
    // values registered below are covered by every subsequent log line.
    patchConsoleForSecrets();
  }

  const env = options.env ?? process.env;
  for (const name of ENVIRONMENT_CREDENTIAL_NAMES) {
    registerSecretValue(env[name], `env:${name}`);
  }

  const schemaPath = options.schemaPath === undefined
    ? findEnvSchemaPath(options.startDirectory ?? process.cwd())
    : options.schemaPath;
  let varlockLoaded = false;
  if (schemaPath) {
    try {
      const loadSecrets = options.loadSecrets ?? registerSecretsFromEnvSchema;
      const count = await loadSecrets(schemaPath);
      varlockLoaded = true;
      log(`[openscout-runtime] secret redaction: registered ${count} value(s) from ${schemaPath}`);
    } catch (error) {
      log(`[openscout-runtime] secret redaction: varlock load failed (continuing without it): ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }

  return {
    registered: registeredSecretCount(),
    schemaPath,
    varlockLoaded,
  };
}
