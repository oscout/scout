/**
 * Harness auth models: how a harness authenticates, declared once.
 *
 * Scout's design center is *delegated* auth — a harness authenticates itself
 * (`claude login`, `cursor-agent login`) and Scout only detects that it did.
 * But some harnesses have no vendor login at all (`flue`), and for others we
 * resolve and inject a credential ourselves. That second category is where
 * both of the 2026-08-04 credential leaks came from: Scout can only leak a key
 * it holds, and it only holds keys for brokered harnesses.
 *
 * Until now the auth facts were spread across three lists that disagreed with
 * each other — `readiness.anyOf` in the runtime harness catalog, the redaction
 * bootstrap's credential-name array, and each adapter's own env bridging. The
 * disagreement is not cosmetic: it is why `CLAUDE_CODE_OAUTH_TOKEN` was absent
 * from redaction *and* from readiness. This module makes the auth model the
 * single declaration those consumers derive from.
 *
 * Deliberately dependency-free. `@openscout/agent-sessions` is a leaf package,
 * so a descriptor here cannot reach varlock, a keychain, or the filesystem —
 * *what* a harness needs stays separate from *how* this machine supplies it.
 * Resolution is the resolver's job (see `CredentialResolver`), which lets the
 * same descriptor drive a laptop keychain, a varlock schema, or a cloud secret
 * manager without an adapter changing.
 */

/**
 * Which account a credential bills against. `claude setup-token` mints a
 * subscription-billed token while `ANTHROPIC_API_KEY` bills API rates for the
 * same harness, so this is a real operator-visible difference, not a label.
 */
export type CredentialBilling = "subscription" | "api" | "unknown";

/**
 * `portable` answers: does this credential still work on a different machine?
 * An env-var token does; a login cache keyed to a local OAuth flow does not.
 * This is the field that decides what has to be seeded into a cloud instance.
 */
export type HarnessCredential =
  | {
    kind: "env";
    key: string;
    /** Whether the value must be scrubbed from logs, tail, and transcripts. */
    secret: boolean;
    portable: boolean;
    /**
     * Whether the presence of this variable alone means the harness is
     * authenticated. False for values that accompany a credential without
     * being one — a refresh token proves a prior login happened but cannot
     * authenticate a request by itself. Such values are still redacted.
     */
    readinessSignal?: boolean;
    billing?: CredentialBilling;
    /** True for the `SCOUT_<VENDOR>_API_KEY` namespace Scout itself defines. */
    scoutOwned?: boolean;
    label?: string;
  }
  | {
    kind: "file";
    path: string;
    portable: boolean;
    fileType?: "file" | "directory" | "any";
    label?: string;
  }
  | {
    /**
     * A settings hook naming a command that returns the credential (Claude
     * Code's `apiKeyHelper`). The credential never lands in a file or an env
     * dict, which makes it the cleanest option where a harness supports it.
     */
    kind: "helper";
    setting: string;
    label?: string;
  };

/**
 * A vendor credential domain — the unit that actually owns an API key.
 *
 * Keyed by vendor rather than by harness because the mapping is not 1:1:
 * `grok` and `grok-acp` are two catalog entries sharing one xAI credential,
 * and `pi` consumes seven vendors' keys. Declaring per-harness would duplicate
 * xAI and leave pi unrepresentable.
 */
export type CredentialDomain = {
  id: string;
  label: string;
  /** Env credentials for this vendor, most-preferred first. */
  env: Array<Extract<HarnessCredential, { kind: "env" }>>;
};

/**
 * How a harness obtains a credential that works on *another* machine.
 * `login` is interactive and machine-local; `provision` mints something
 * transportable (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`).
 */
export type HarnessAuthProvisioning = {
  command: string;
  /** Env var the minted credential is delivered through. */
  yields: string;
  portable: boolean;
  note?: string;
};

/**
 * - `delegated` — the vendor CLI owns the credential; Scout only detects it.
 * - `brokered` — Scout resolves and injects the credential itself.
 * - `hybrid` — delegated when a vendor login exists, brokered otherwise.
 *
 * In a cloud instance `delegated` collapses into `brokered`: there is no
 * prior interactive login on a fresh box, so anything not `portable` has to
 * be seeded. That makes this field the manifest of what cloud deployment owes
 * each harness.
 */
export type HarnessAuthMode = "delegated" | "brokered" | "hybrid";

export type HarnessAuthModel = {
  harness: string;
  mode: HarnessAuthMode;
  /** Vendor domains this harness draws credentials from. */
  domains: string[];
  /**
   * Full credential precedence for this harness, **most-preferred first**.
   *
   * Order is load-bearing, not documentation: OpenCode's `auth.json` beats
   * `OPENCODE_API_KEY`, so a cloud image with a seeded auth.json silently
   * ignores an injected key and runs on the wrong account. Declaring the
   * order makes that testable instead of folklore.
   */
  credentials: HarnessCredential[];
  login?: { command: string; interactive: boolean };
  provision?: HarnessAuthProvisioning;
  /** Shown when nothing in `credentials` is satisfiable. */
  notReadyMessage?: string;
};

/**
 * Supplies values for declared credentials. Implementations live outside this
 * package: process env, the macOS keychain via the `secret` CLI, a varlock
 * `.env.schema`, or a cloud secret manager. Varlock is one implementation of
 * this interface, never the architecture.
 */
export interface CredentialResolver {
  /** Resolved value, or null when this resolver cannot supply the credential. */
  resolve(credential: HarnessCredential): string | null;
  /** Optional label used in diagnostics; never logged next to a value. */
  readonly id?: string;
}
