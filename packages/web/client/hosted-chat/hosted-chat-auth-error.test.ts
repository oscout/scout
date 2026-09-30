import { describe, expect, test } from "bun:test";

import { authErrorFromSearch, readAuthError } from "./hosted-chat-auth-error.ts";

describe("why a sign-in did not finish", () => {
  test("a cancelled sign-in says nothing was created", () => {
    const notice = readAuthError("oauth_denied")!;
    expect(notice.message).toContain("cancelled");
    expect(notice.retryable).toBe(true);
    expect(notice.provider).toBeNull();
  });

  test("an unconfigured provider is named and offers no retry", () => {
    const notice = readAuthError("x_auth_unconfigured")!;
    expect(notice.message).toBe("Sign-in with X is not set up on this deployment yet.");
    expect(notice.retryable).toBe(false);
    // Another door may still work; the door only says so when it has one.
    expect(notice.alternative).toBe(true);
    expect(notice.provider).toBe("x");
    expect(readAuthError("google_auth_unconfigured")!.message).toContain("Google");
  });

  test("a provider outage is named and can be retried", () => {
    expect(readAuthError("github_unavailable")).toMatchObject({ provider: "github", retryable: true });
    expect(readAuthError("google_exchange_failed")!.message).toContain("Google");
    expect(readAuthError("x_identity_invalid")!.provider).toBe("x");
  });

  test("a missing verified email says which account to fix", () => {
    expect(readAuthError("github_verified_email_required")!.message).toContain("verified email address on your GitHub account");
    expect(readAuthError("google_verified_email_required")!.retryable).toBe(false);
  });

  test("a cancelled sign-in never suggests a different provider", () => {
    expect(readAuthError("oauth_denied")!.alternative).toBe(false);
    expect(readAuthError("invalid_oauth_state")!.alternative).toBe(false);
  });

  test("an unknown reason gets the general sentence, never the raw reason as prose", () => {
    const notice = readAuthError("something_new_from_a_later_worker")!;
    expect(notice.message).toBe("Sign-in could not be completed. Try again.");
    expect(notice.code).toBe("something_new_from_a_later_worker");
  });

  test("a reason that is not shaped like one is never printed at all", () => {
    const notice = readAuthError("<img src=x onerror=alert(1)>")!;
    expect(notice.message).toBe("Sign-in could not be completed. Try again.");
    expect(notice.code).toBeNull();
    expect(readAuthError("Google is down, call 555-0100")!.code).toBeNull();
  });

  test("no reason in the address is no notice", () => {
    expect(readAuthError(null)).toBeNull();
    expect(readAuthError("")).toBeNull();
    expect(authErrorFromSearch("?claim=atlas")).toBeNull();
    expect(authErrorFromSearch("?claim=atlas&auth_error=oauth_denied")!.retryable).toBe(true);
  });
});
