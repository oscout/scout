/**
 * Operator HTTP client for hosted Chat `/admin`.
 *
 * Aligned with `apps/hosted-chat/src/paths.ts` (`CHAT_OPS_PATHS`) and the
 * Worker routes in `apps/hosted-chat/src/index.ts`. This is not the Chat
 * surface adapter: it never inspects every space on load, and it never sends
 * an agent bearer.
 */

import { ChatApiError } from "../screens/chat-space/chat-api.ts";

/** Same paths the Worker serves. Host is the page origin. */
export const HOSTED_OPS_PATHS = {
  document: "/admin",
  snapshot: "/api/ops",
  controls: "/api/ops/controls",
  space: (id: string) => `/api/ops/spaces/${id}`,
  revoke: (id: string) => `/api/ops/spaces/${id}/revoke`,
  session: "/api/auth/session",
} as const;

export type HostedOpsOmitted = {
  billedDatabaseStorage: string;
  totalStorage: string;
  costs: string;
};

export type HostedOpsLabels = {
  retainedPayloadBytes: string;
  lastAuthenticatedActivity: string;
};

export type HostedOpsSnapshot = {
  at: number;
  readiness: { ok: boolean; checked: string[]; omitted: HostedOpsOmitted; servicePaused: boolean };
  controls: { signupPaused: boolean; servicePaused: boolean; invitesPaused: boolean; spacesPerAccount: number };
  environmentLocks: { signupPaused: boolean; servicePaused: boolean };
  counts: { accounts: number; spaces: { active: number; provisioning: number; deleting: number; deleted: number; total: number } };
  spaces: { id: string; ownerAccountId: string; title: string; slug: string; status: string; createdAt: number; readOnly: boolean }[];
  spacesTruncated: boolean;
  usage: { windowMinutes: number; requests: number; errors: number; slow: number; durationMs: number; averageLatencyMs: number | null };
  failures: { at: number; route: string; status: number; duration: number }[];
  failuresTruncated: boolean;
  audit: { at: number; actor: string; action: string; target: string; value: number }[];
  auditTruncated: boolean;
  omitted: HostedOpsOmitted;
  labels: HostedOpsLabels;
};

export type HostedOpsSpaceDetail = {
  channels: { id: string; title: string }[];
  members: {
    actorId: string;
    displayName: string;
    channelId: string;
    expiresAt: number;
    revoked: number;
    lastAuthenticatedActivity: number | null;
  }[];
  messageCount: number;
  retainedPayloadBytes: number;
  labels: HostedOpsLabels;
  audit: { at: number; actor: string; action: string; target: string }[];
};

type HostedSession = { authenticated: boolean; account?: { id: string; displayName: string }; csrfToken?: string };

function opsMessage(reason: string | null): string | null {
  if (!reason) return null;
  const sentences: Record<string, string> = {
    owner_sign_in_required: "Sign in with the operator GitHub account.",
    operator_required: "This page is limited to the allowlisted operator.",
    csrf_denied: "Your session changed. Reload this page before trying again.",
    origin_denied: "That request did not come from this site.",
    environment_lock: "That pause is locked by the deployment configuration.",
    space_not_found: "That space is not in the directory.",
    member_not_found: "That member is not in this space.",
    invalid_control: "That control is not recognized.",
    invalid_control_value: "That control value was rejected.",
    invalid_control_target: "That control needs an exact space id.",
  };
  return sentences[reason] ?? null;
}

export function createHostedOpsApi() {
  let csrfToken: string | null = null;

  async function raw<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
        headers: { accept: "application/json", ...(init?.headers ?? {}) },
      });
    } catch (error) {
      throw new ChatApiError(error instanceof Error ? error.message : "Network request failed", 0);
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text) as unknown; } catch { payload = null; }
    }
    if (!response.ok) {
      const record = (payload ?? {}) as { error?: unknown; reason?: unknown };
      const reason = typeof record.reason === "string" ? record.reason : typeof record.error === "string" ? record.error : null;
      throw new ChatApiError(opsMessage(reason) ?? `${init?.method ?? "GET"} ${path} failed (${response.status})`, response.status, reason);
    }
    return (payload ?? {}) as T;
  }

  async function session(): Promise<HostedSession> {
    const found = await raw<HostedSession>(HOSTED_OPS_PATHS.session);
    csrfToken = found.authenticated && found.csrfToken ? found.csrfToken : null;
    return found;
  }

  async function write<T>(path: string, body: unknown): Promise<T> {
    if (!csrfToken) {
      const found = await session();
      if (!found.authenticated) throw new ChatApiError("Sign in with the operator GitHub account.", 401, "owner_sign_in_required");
    }
    const send = () => raw<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken ?? "" },
      body: JSON.stringify(body ?? {}),
    });
    try {
      return await send();
    } catch (error) {
      if (error instanceof ChatApiError && error.reason === "csrf_denied") {
        const found = await session();
        if (found.authenticated && csrfToken) return await send();
      }
      throw error;
    }
  }

  return {
    session,
    snapshot(): Promise<HostedOpsSnapshot> {
      return raw<HostedOpsSnapshot>(HOSTED_OPS_PATHS.snapshot);
    },
    async inspect(spaceId: string): Promise<HostedOpsSpaceDetail> {
      if (!/^[a-f0-9]{32}$/.test(spaceId)) {
        throw new ChatApiError("That space is not in the directory.", 404, "space_not_found");
      }
      return raw<HostedOpsSpaceDetail>(HOSTED_OPS_PATHS.space(spaceId));
    },
    setControl(key: string, value: number, target?: string): Promise<{ ok: true }> {
      return write<{ ok: true }>(HOSTED_OPS_PATHS.controls, target ? { key, value, target } : { key, value });
    },
    revokeMember(spaceId: string, actorId: string, channelId: string): Promise<{ ok: true }> {
      return write<{ ok: true }>(HOSTED_OPS_PATHS.revoke(spaceId), { actorId, channelId });
    },
  };
}

export type HostedOpsApi = ReturnType<typeof createHostedOpsApi>;
