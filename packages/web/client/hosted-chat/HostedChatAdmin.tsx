/**
 * Operator-only hosted Chat operations page at `/admin`.
 *
 * Uses the same Chat theme tokens and primitives as the room. It is not the
 * operator broker shell, and it does not poll every space.
 */

import { useCallback, useEffect, useState } from "react";

import { ChatApiError } from "../screens/chat-space/chat-api.ts";
import { ChatSpaceTheme, useScoutStandaloneAppearance } from "../screens/chat-space/ChatSpaceTheme.tsx";
import { HOSTED_CHAT_CAPABILITIES } from "./hosted-chat-api.ts";
import {
  createHostedOpsApi,
  type HostedOpsApi,
  type HostedOpsSnapshot,
  type HostedOpsSpaceDetail,
} from "./hosted-chat-ops-api.ts";

import "./hosted-chat-admin.css";

type Gate = "loading" | "signin" | "forbidden" | "ready" | "error";

function when(at: number): string {
  return new Date(at).toLocaleString();
}

export function HostedChatAdmin({ api }: { api?: HostedOpsApi } = {}) {
  const { theme } = useScoutStandaloneAppearance();
  const [client] = useState(() => api ?? createHostedOpsApi());
  const [gate, setGate] = useState<Gate>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<HostedOpsSnapshot | null>(null);
  const [detail, setDetail] = useState<{ id: string; data: HostedOpsSpaceDetail } | null>(null);
  const [quota, setQuota] = useState("3");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setMessage(null);
    try {
      const session = await client.session();
      if (!session.authenticated) {
        setGate("signin");
        setSnapshot(null);
        return;
      }
      const next = await client.snapshot();
      setSnapshot(next);
      setQuota(String(next.controls.spacesPerAccount));
      setGate("ready");
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 401) {
        setGate("signin");
        setSnapshot(null);
        return;
      }
      if (error instanceof ChatApiError && error.reason === "operator_required") {
        setGate("forbidden");
        setSnapshot(null);
        return;
      }
      setGate("error");
      setMessage(error instanceof Error ? error.message : "Operations could not be loaded.");
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 401) {
        setGate("signin");
        setSnapshot(null);
        return;
      }
      if (error instanceof ChatApiError && error.reason === "operator_required") {
        setGate("forbidden");
        setSnapshot(null);
        return;
      }
      setMessage(error instanceof Error ? error.message : "That control was rejected.");
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const data = await client.inspect(id);
      setDetail({ id, data });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That space could not be inspected.");
    } finally {
      setBusy(false);
    }
  };

  if (gate === "loading" || gate === "signin" || gate === "forbidden" || gate === "error") {
    const title = gate === "signin" ? "Sign in to continue" : gate === "forbidden" ? "Operator only" : gate === "error" ? "Operations unavailable" : "Loading operations…";
    return (
      <ChatSpaceTheme theme={theme} className="chat-centered">
        <div className="chat-card">
          <span className="chat-card-eyebrow">Scout Chat</span>
          <h1>{title}</h1>
          {gate === "signin" ? (
            <>
              <p>This page is the operator operations surface. It is not a space and it is not granted by owning a room.</p>
              <a
                className="btn btn--accent"
                href={`${HOSTED_CHAT_CAPABILITIES.signIn.startPath}?${HOSTED_CHAT_CAPABILITIES.signIn.returnToParam}=${encodeURIComponent("/admin")}`}
              >
                {HOSTED_CHAT_CAPABILITIES.signIn.label}
              </a>
            </>
          ) : gate === "forbidden" ? (
            <p>Signed in, but this GitHub account is not the allowlisted operator.</p>
          ) : gate === "error" ? (
            <>
              <p>{message ?? "The operations API did not answer."}</p>
              <button type="button" className="btn" onClick={() => void load()}>Try again</button>
            </>
          ) : (
            <p className="chat-card-meta">Loading Scout Chat operations…</p>
          )}
        </div>
      </ChatSpaceTheme>
    );
  }

  if (!snapshot) return null;
  const { controls, environmentLocks, counts, usage, omitted, labels } = snapshot;

  return (
    <ChatSpaceTheme theme={theme} className="hca">
      <header className="hca-topbar">
        <b>Scout Chat operations</b>
        <span>{snapshot.readiness.ok ? "Directory reachable" : "Service paused"}</span>
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void load()}>Refresh</button>
      </header>
      <div className="hca-body">
        {message ? <p className="hca-error" role="alert">{message}</p> : null}

        <section className="hca-section">
          <h2>Readiness</h2>
          <div className="hca-grid">
            <div className="hca-stat"><span className="hca-muted">Directory SQLite</span><b>{snapshot.readiness.checked.includes("directory_sqlite") ? "checked" : "omitted"}</b></div>
            <div className="hca-stat"><span className="hca-muted">Accepting traffic</span><b>{snapshot.readiness.ok ? "yes" : "no"}</b></div>
            <div className="hca-stat"><span className="hca-muted">Service pause</span><b>{snapshot.readiness.servicePaused ? "paused" : "running"}</b></div>
          </div>
          <p className="hca-note">{omitted.billedDatabaseStorage} {omitted.totalStorage} {omitted.costs}</p>
        </section>

        <section className="hca-section">
          <h2>Last hour</h2>
          <div className="hca-grid">
            <div className="hca-stat"><span className="hca-muted">Requests</span><b>{usage.requests}</b></div>
            <div className="hca-stat"><span className="hca-muted">Errors (5xx)</span><b>{usage.errors}</b></div>
            <div className="hca-stat"><span className="hca-muted">Slow (≥2s)</span><b>{usage.slow}</b></div>
            <div className="hca-stat"><span className="hca-muted">Average latency</span><b>{usage.averageLatencyMs == null ? "—" : `${usage.averageLatencyMs} ms`}</b></div>
          </div>
          <p className="hca-note">Totals cover classified API routes only. Static pages, health probes, and unknown paths are not stored.</p>
        </section>

        <section className="hca-section">
          <h2>Counts</h2>
          <div className="hca-grid">
            <div className="hca-stat"><span className="hca-muted">Accounts</span><b>{counts.accounts}</b></div>
            <div className="hca-stat"><span className="hca-muted">Active spaces</span><b>{counts.spaces.active}</b></div>
            <div className="hca-stat"><span className="hca-muted">Spaces including tombstones</span><b>{counts.spaces.total}</b></div>
          </div>
        </section>

        <section className="hca-section">
          <h2>Controls</h2>
          <div className="hca-row">
            <button type="button" className="btn btn--sm" disabled={busy || (environmentLocks.signupPaused && controls.signupPaused)} onClick={() => void mutate(() => client.setControl("signupPaused", controls.signupPaused ? 0 : 1))}>
              {controls.signupPaused ? "Resume signup" : "Pause signup"}
            </button>
            {environmentLocks.signupPaused ? <span className="hca-warning">Signup pause is locked by the environment.</span> : null}
          </div>
          <div className="hca-row">
            <button type="button" className="btn btn--sm" disabled={busy || (environmentLocks.servicePaused && controls.servicePaused)} onClick={() => void mutate(() => client.setControl("servicePaused", controls.servicePaused ? 0 : 1))}>
              {controls.servicePaused ? "Resume service" : "Pause service"}
            </button>
            {environmentLocks.servicePaused ? <span className="hca-warning">Service pause is locked by the environment.</span> : null}
          </div>
          <div className="hca-row">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void mutate(() => client.setControl("invitesPaused", controls.invitesPaused ? 0 : 1))}>
              {controls.invitesPaused ? "Resume invites" : "Pause invites"}
            </button>
            <span className="hca-muted">Creation and redemption.</span>
          </div>
          <form className="hca-row" onSubmit={(event) => {
            event.preventDefault();
            const value = Number(quota);
            if (!Number.isInteger(value) || value < 1) { setMessage("Space quota must be an integer from 1 to 100."); return; }
            void mutate(() => client.setControl("spacesPerAccount", value));
          }}>
            <label className="hca-muted" htmlFor="hca-quota">Spaces per account</label>
            <input id="hca-quota" className="hca-input" value={quota} onChange={(event) => setQuota(event.target.value)} inputMode="numeric" />
            <button type="submit" className="btn btn--sm" disabled={busy}>Save quota</button>
            <span className="hca-muted">Owner exemption is unchanged.</span>
          </form>
        </section>

        <section className="hca-section">
          <h2>Spaces</h2>
          {snapshot.spacesTruncated ? <p className="hca-note">List truncated; older rows are omitted.</p> : null}
          <table className="hca-table">
            <thead>
              <tr><th>Slug</th><th>Status</th><th>Read-only</th><th></th></tr>
            </thead>
            <tbody>
              {snapshot.spaces.map((space) => (
                <tr key={space.id}>
                  <td>{space.slug}</td>
                  <td>{space.status}</td>
                  <td>{space.readOnly ? "yes" : "no"}</td>
                  <td className="hca-row">
                    <button type="button" disabled={busy || space.status !== "active"} onClick={() => void inspect(space.id)}>Inspect</button>
                    {space.status === "active" ? (
                      <button type="button" disabled={busy} onClick={() => void mutate(() => client.setControl("readOnly", space.readOnly ? 0 : 1, space.id))}>
                        {space.readOnly ? "Allow writes" : "Make read-only"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hca-note">{labels.retainedPayloadBytes} {labels.lastAuthenticatedActivity} Inspect loads one known directory space and does not create objects.</p>
          {detail ? (
            <div>
              <h2>Inspection</h2>
              <p className="hca-muted">{detail.id} · {detail.data.messageCount} messages · {detail.data.retainedPayloadBytes} retained payload bytes</p>
              <table className="hca-table">
                <thead>
                  <tr><th>Member</th><th>Channel</th><th>Last authenticated activity</th><th></th></tr>
                </thead>
                <tbody>
                  {detail.data.members.map((member) => (
                    <tr key={`${member.actorId}:${member.channelId}`}>
                      <td>{member.displayName}{member.revoked ? " (revoked)" : ""}</td>
                      <td>{member.channelId}</td>
                      <td>{member.lastAuthenticatedActivity == null ? "—" : when(member.lastAuthenticatedActivity)}</td>
                      <td>
                        {member.revoked ? null : (
                          <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => void mutate(async () => {
                            await client.revokeMember(detail.id, member.actorId, member.channelId);
                            await inspect(detail.id);
                          })}>Revoke</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="hca-section">
          <h2>Recent errors</h2>
          {snapshot.failuresTruncated ? <p className="hca-note">List truncated to the newest rows.</p> : null}
          <table className="hca-table">
            <thead>
              <tr><th>When</th><th>Route</th><th>Status</th><th>Duration</th></tr>
            </thead>
            <tbody>
              {snapshot.failures.map((row, index) => (
                <tr key={`${row.at}:${row.route}:${index}`}>
                  <td>{when(row.at)}</td>
                  <td>{row.route}</td>
                  <td>{row.status}</td>
                  <td>{row.duration} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="hca-section">
          <h2>Audit</h2>
          {snapshot.auditTruncated ? <p className="hca-note">List truncated to the newest rows.</p> : null}
          <table className="hca-table">
            <thead>
              <tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Value</th></tr>
            </thead>
            <tbody>
              {snapshot.audit.map((row, index) => (
                <tr key={`${row.at}:${row.action}:${index}`}>
                  <td>{when(row.at)}</td>
                  <td>{row.actor}</td>
                  <td>{row.action}</td>
                  <td>{row.target}</td>
                  <td>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </ChatSpaceTheme>
  );
}
