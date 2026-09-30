/**
 * Why a sign-in did not finish, in the visitor's language.
 *
 * The Worker refuses in machine terms — `x_auth_unconfigured`, `oauth_denied`,
 * `github_unavailable`. When a browser was navigating rather than fetching, it
 * sends the visitor back to the door with that reason in `?auth_error=`
 * (`apps/hosted-chat/src/auth.ts`, `CHAT_AUTH_ERROR_PARAM`) instead of serving
 * a page of JSON. This file is the only place that turns one into a sentence.
 *
 * The reason is a value from the address bar, so it is never printed as prose:
 * every sentence comes from the table below, and an unrecognised reason gets
 * the general sentence. The code itself is shown beside it only when it matches
 * a strict machine shape, because in a pilot the person reading the door is
 * often the person who has to fix it.
 */

/** Matches `CHAT_AUTH_ERROR_PARAM` in the Worker. */
export const AUTH_ERROR_PARAM = "auth_error";

export interface AuthErrorNotice {
  /** The sentence to show. Always from this file, never from the address. */
  message: string;
  /** The Worker's own reason, when it is safe to print. */
  code: string | null;
  /** Whether trying the same door again could plausibly work. */
  retryable: boolean;
  /** Whether a different provider is worth trying. Only said when there is one. */
  alternative: boolean;
  /** The provider this was about, when the reason names one. */
  provider: string | null;
}

const PROVIDER_LABELS: Record<string, string> = { github: "GitHub", google: "Google", x: "X" };

/** Reasons that are about one provider, keyed by the suffix after its id. */
const PROVIDER_REASONS: Record<string, (label: string) => Omit<AuthErrorNotice, "code" | "provider">> = {
  auth_unconfigured: (label) => ({
    message: `Sign-in with ${label} is not set up on this deployment yet.`,
    retryable: false,
    alternative: true,
  }),
  verified_email_required: (label) => ({
    message: `Scout Chat needs a verified email address on your ${label} account. Verify it with ${label}, then sign in again.`,
    retryable: false,
    alternative: true,
  }),
  unavailable: (label) => ({
    message: `${label} did not answer in time. Try again in a moment.`,
    retryable: true,
    alternative: true,
  }),
  exchange_failed: (label) => ({
    message: `${label} did not complete the sign-in.`,
    retryable: true,
    alternative: true,
  }),
  identity_invalid: (label) => ({
    message: `${label} returned an account Scout Chat could not read.`,
    retryable: true,
    alternative: true,
  }),
  response_invalid: (label) => ({
    message: `${label} returned something Scout Chat could not read. Try again in a moment.`,
    retryable: true,
    alternative: true,
  }),
};

/** Reasons that stand on their own. */
const REASONS: Record<string, Omit<AuthErrorNotice, "code" | "provider">> = {
  oauth_denied: {
    message: "Sign-in was cancelled, so no account was created. Nothing was shared with Scout Chat.",
    retryable: true,
    alternative: false,
  },
  invalid_oauth_state: {
    message: "That sign-in took too long or was already used. Start it again from this page.",
    retryable: true,
    alternative: false,
  },
  invalid_oauth_code: {
    message: "That sign-in could not be completed. Start it again from this page.",
    retryable: true,
    alternative: false,
  },
  account_unavailable: {
    message: "That account cannot sign in to Scout Chat. Ask the operator if you think this is wrong.",
    retryable: false,
    alternative: false,
  },
  auth_unavailable: {
    message: "Sign-in is temporarily unavailable. Try again in a moment.",
    retryable: true,
    alternative: false,
  },
  origin_denied: {
    message: "That sign-in link did not come from this address. Start again from this page.",
    retryable: true,
    alternative: false,
  },
};

const GENERAL: Omit<AuthErrorNotice, "code" | "provider"> = {
  message: "Sign-in could not be completed. Try again.",
  retryable: true,
  alternative: false,
};

/** A reason shaped like the Worker's own, so nothing else is ever rendered. */
const REASON_SHAPE = /^[a-z][a-z0-9_]{0,48}$/;

/** Turn one Worker reason into something to read. `null` for no reason at all. */
export function readAuthError(reason: string | null | undefined): AuthErrorNotice | null {
  if (!reason) return null;
  const code = REASON_SHAPE.test(reason) ? reason : null;
  const known = REASONS[reason];
  if (known) return { ...known, code, provider: null };
  for (const [id, label] of Object.entries(PROVIDER_LABELS)) {
    if (!reason.startsWith(`${id}_`)) continue;
    const shaped = PROVIDER_REASONS[reason.slice(id.length + 1)];
    if (shaped) return { ...shaped(label), code, provider: id };
  }
  return { ...GENERAL, code, provider: null };
}

/** The same, read straight off `location.search`. */
export function authErrorFromSearch(search: string): AuthErrorNotice | null {
  return readAuthError(new URLSearchParams(search).get(AUTH_ERROR_PARAM));
}
