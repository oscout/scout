import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../lib/surface-activity.ts";
import "./pairing-request-prompt.css";

/** Mirror of the server's `PairRequest` (pairing-pair-requests.ts). */
interface PairRequest {
  token: string;
  status: "pending" | "approved" | "denied";
  requesterIp: string | null;
  requesterLabel: string | null;
  route: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface PairingRequestNotification {
  type: "pairing_request";
  data?: {
    request?: PairRequest;
  };
}

const NOTIFICATION_POLL_MS = 15_000;
const ERROR_POLL_MS = 30_000;

/**
 * Surfaces incoming LAN pairing requests on the Mac. A phone that taps an idle
 * Mac in "On your network" registers an approval-gated request; initial pairing
 * is trust-on-first-use, so a human here must allow it before pair mode starts
 * and the device is trusted. Reads pairing prompts from the shared
 * notification inbox instead of polling pairing-specific state.
 */
export function PairingRequestPrompt() {
  const [requests, setRequests] = useState<PairRequest[]>([]);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const pollTimer = useRef<number | null>(null);

  const refreshNotifications = useCallback(async (): Promise<boolean> => {
    try {
      const res = await api<{ notifications: PairingRequestNotification[] }>(
        "/api/notifications?type=pairing_request",
      );
      if (!mounted.current) return true;
      const pending = res.notifications
        .map((notification) => notification.data?.request)
        .filter((request): request is PairRequest => request?.status === "pending");
      setRequests(pending);
      return true;
    } catch {
      // Transient — keep the last known set and try again next tick.
      return false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;

    const clearPollTimer = () => {
      if (pollTimer.current === null) return;
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };

    const scheduleNextPoll = (delayMs: number) => {
      clearPollTimer();
      pollTimer.current = window.setTimeout(() => {
        void runPoll();
      }, delayMs);
    };

    const runPoll = async () => {
      clearPollTimer();
      if (!isScoutSurfaceActive()) return;
      const ok = await refreshNotifications();
      if (disposed || !mounted.current) return;
      scheduleNextPoll(ok ? NOTIFICATION_POLL_MS : ERROR_POLL_MS);
    };

    void runPoll();
    const stopActivationListener = onScoutSurfaceActivated(() => void runPoll());

    return () => {
      disposed = true;
      mounted.current = false;
      clearPollTimer();
      stopActivationListener();
    };
  }, [refreshNotifications]);

  const decide = useCallback(
    async (token: string, decision: "approve" | "deny") => {
      setBusyToken(token);
      setError(null);
      try {
        await api(`/api/pairing/requests/${encodeURIComponent(token)}/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        setRequests((prev) => prev.filter((request) => request.token !== token));
        void refreshNotifications();
      } catch (decideError) {
        setError(decideError instanceof Error ? decideError.message : String(decideError));
      } finally {
        setBusyToken(null);
      }
    },
    [refreshNotifications],
  );

  if (requests.length === 0) return null;

  const request = requests[0];
  const label = request.requesterLabel?.trim() || "A device";
  const isBusy = busyToken === request.token;

  return (
    <div className="scout-pair-prompt" role="alertdialog" aria-label="Pairing request">
      <div className="scout-pair-prompt-card">
        <div className="scout-pair-prompt-eyebrow">Pairing request</div>
        <div className="scout-pair-prompt-title">{label} wants to pair</div>
        <div className="scout-pair-prompt-detail">
          On your network{request.requesterIp ? ` · ${request.requesterIp}` : ""}. Allowing
          trusts this device and starts pair mode.
        </div>
        {error ? <div className="scout-pair-prompt-error">{error}</div> : null}
        <div className="scout-pair-prompt-actions">
          <button
            type="button"
            className="scout-pair-prompt-btn scout-pair-prompt-deny"
            disabled={isBusy}
            onClick={() => void decide(request.token, "deny")}
          >
            Deny
          </button>
          <button
            type="button"
            className="scout-pair-prompt-btn scout-pair-prompt-allow"
            disabled={isBusy}
            onClick={() => void decide(request.token, "approve")}
          >
            {isBusy ? "Allowing…" : "Allow"}
          </button>
        </div>
        {requests.length > 1 ? (
          <div className="scout-pair-prompt-more">+{requests.length - 1} more waiting</div>
        ) : null}
      </div>
    </div>
  );
}
