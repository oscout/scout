export class AccessApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const errors: Record<string, string> = {
  invalid_login: "Authentication failed. Check your login, password and current device approval.",
  login_required: "Your session ended. Sign in again.",
  csrf_required: "Your session token expired. Sign in again or refresh this page.",
  preview_expired_or_used: "This preview has expired or was already used. Close it and review the change again.",
  network_changed_refresh_preview: "Access changed while you were reviewing. Close this preview and review the current change again.",
  authentication_rate_limited: "Too many authentication attempts. Wait a minute before trying again.",
  broker_operation_denied: "The broker denied this operation. Your role, grant or device approval may have changed.",
  management_not_authorized: "Your current identity and device do not authorize this change.",
  principal_signer_unavailable: "This login has no principal signing key configured. Use the CLI to sign this change.",
  expiry_exceeds_authority: "Choose an expiry within the current policy and device approval.",
};
export async function accessApi<T>(path: string, payload?: unknown, csrf?: string): Promise<T> {
  const response = await fetch(`/api/access/${path}`, { method: payload === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: payload === undefined ? {} : { "content-type": "application/json", ...(csrf ? { "x-scout-csrf": csrf } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const data = await response.json().catch(() => ({})) as { error?: string; detail?: string };
  if (!response.ok) { const code = data.error ?? "request_failed"; throw new AccessApiError(response.status, code, errors[code] ?? data.detail ?? `Request could not be completed (${code.replaceAll("_", " ")}).`); }
  return data as T;
}
