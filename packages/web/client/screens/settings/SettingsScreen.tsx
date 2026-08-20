import { renderSVG } from "uqr";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../../components/EmptyState.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { api } from "../../lib/api.ts";
import { pairingTone } from "../../lib/status-tone.ts";
import { timeAgo } from "../../lib/time.ts";
import type { PairingState, Route } from "../../lib/types.ts";
import { pairingDeepLinks } from "../../../shared/pairing-link.js";
import { AgentConfigurationScreen } from "../agents/AgentConfigurationScreen.tsx";
import { SettingsPage, type DrawerSettingsSection } from "./SettingsDrawer.tsx";
import "../system-surfaces-redesign.css";

function relayHostLabel(input: string | null): string | null {
  if (!input) return null;
  return input.replace(/^wss?:\/\//, "").replace(/:\d+$/, "");
}

function shortFingerprint(input: string | null): string | null {
  if (!input) return null;
  if (input.length <= 18) return input;
  return `${input.slice(0, 10)}...${input.slice(-6)}`;
}

function formatExpiresIn(expiresAt: number | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const diffSeconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  if (diffSeconds === 0) return null;
  if (diffSeconds < 60) return `${diffSeconds}s`;
  const minutes = Math.floor(diffSeconds / 60);
  const seconds = diffSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <button type="button" className="sys-copy-btn" onClick={onClick} title="Copy">
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function PairRouteLink({ label, value }: { label: string; value: string }) {
  return (
    <span className="sys-settings-route-link">
      <a className="sys-settings-link" href={value} title={value} aria-label={`Open Scout ${label} pairing link`}>
        <code>{label}</code>
      </a>
      <CopyButton value={value} />
    </span>
  );
}

function AgentConfigRedirect({
  agentId,
  navigate,
}: {
  agentId: string;
  navigate: (r: Route) => void;
}) {
  useEffect(() => {
    navigate({ view: "agents-v2", agentId, tab: "config" });
  }, [agentId, navigate]);
  return null;
}

export function SettingsScreen({
  navigate,
  section,
  agentId,
}: {
  navigate: (r: Route) => void;
  section?: import("../../lib/types.ts").SettingsSection;
  agentId?: string;
}) {
  if (section === "agents" && agentId) {
    return <AgentConfigRedirect agentId={agentId} navigate={navigate} />;
  }
  if (section === "agents") {
    return <AgentConfigurationScreen navigate={navigate} selectedAgentId={agentId} />;
  }

  // First-class Settings pages. Each section owns a URL and renders in the
  // normal center workspace; there is no modal/drawer presentation.
  if (
    section === undefined
    || section === "appearance"
    || section === "operator"
    || section === "comms"
    || section === "credentials"
    || section === "voice"
    || section === "devices"
    || section === "about"
  ) {
    const pageSection = (section ?? "appearance") as DrawerSettingsSection;
    return (
      <SettingsPage
        section={pageSection}
        onSectionChange={(nextSection) => navigate({ view: "settings", section: nextSection })}
      />
    );
  }

  // Detailed pairing diagnostics remain available at /settings/pairing.
  return <PairingSettingsScreen />;
}

function PairingSettingsScreen() {
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [userName, setUserName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [controlBusy, setControlBusy] = useState<"start" | "stop" | "restart" | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [removingPeer, setRemovingPeer] = useState<string | null>(null);

  const pairingRef = useRef<PairingState | null>(null);
  const pairingRequestIdRef = useRef(0);
  const controlBusyRef = useRef<"start" | "stop" | "restart" | null>(null);

  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => {
    controlBusyRef.current = controlBusy;
  }, [controlBusy]);

  useEffect(() => {
    if (!pairing || window.location.hash !== "#trusted-peers") return;
    window.requestAnimationFrame(() => {
      document.getElementById("trusted-peers")?.scrollIntoView({ block: "start" });
    });
  }, [pairing]);

  const loadPairing = useCallback(async (mode: "initial" | "background" | "manual" = "initial") => {
    if (mode === "background" && controlBusyRef.current) {
      return;
    }

    const requestId = ++pairingRequestIdRef.current;
    const hasSnapshot = pairingRef.current !== null;

    if (!hasSnapshot && mode !== "background") {
      setLoading(true);
      setPairingError(null);
    } else {
      setRefreshing(true);
    }

    try {
      const nextPairing = await api<PairingState>(
        mode === "manual" ? "/api/pairing-state/refresh" : "/api/pairing-state",
      );
      if (requestId !== pairingRequestIdRef.current) return;
      setPairing(nextPairing);
      setPairingError(null);
      setLastLoadedAt(Date.now());
    } catch (loadError) {
      if (requestId !== pairingRequestIdRef.current) return;
      setPairingError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === pairingRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const loadUser = useCallback(async () => {
    try {
      const user = await api<{ name: string }>("/api/user");
      setSavedName(user.name);
      setUserName(user.name);
      setIdentityError(null);
    } catch (loadError) {
      setIdentityError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const autoStartedRef = useRef(false);

  useEffect(() => {
    void loadPairing("initial");
    void loadUser();
  }, [loadPairing, loadUser]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadPairing("background");
    }, 10_000);
    return () => clearInterval(timer);
  }, [loadPairing]);

  useEffect(() => {
    if (!pairing?.pairing?.expiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, [pairing?.pairing?.expiresAt]);

  const saveName = useCallback(async () => {
    setSavingName(true);
    setIdentityError(null);
    try {
      const result = await api<{ name: string }>("/api/user", {
        method: "POST",
        body: JSON.stringify({ name: userName }),
      });
      setSavedName(result.name);
      setUserName(result.name);
    } catch (saveError) {
      setIdentityError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingName(false);
    }
  }, [userName]);

  const control = useCallback(async (action: "start" | "stop" | "restart") => {
    const requestId = ++pairingRequestIdRef.current;
    setControlBusy(action);
    setPairingError(null);
    try {
      const nextPairing = await api<PairingState>("/api/pairing/control", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (requestId !== pairingRequestIdRef.current) return;
      setPairing(nextPairing);
      setLastLoadedAt(Date.now());
    } catch (controlError) {
      if (requestId !== pairingRequestIdRef.current) return;
      setPairingError(controlError instanceof Error ? controlError.message : String(controlError));
    } finally {
      if (requestId === pairingRequestIdRef.current) {
        setControlBusy(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!pairing || pairing.isRunning || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void control("start");
  }, [pairing, control]);

  const removePeer = useCallback(async (fingerprint: string) => {
    setRemovingPeer(fingerprint);
    try {
      await api(`/api/pairing/peers/${encodeURIComponent(fingerprint)}`, { method: "DELETE" });
      void loadPairing("manual");
    } catch {
      // silently fail — next refresh will show truth
    } finally {
      setRemovingPeer(null);
    }
  }, [loadPairing]);

  const qrSvg = useMemo(() => {
    const value = pairing?.pairing?.qrValue?.trim();
    if (!value) return null;
    return renderSVG(value, { border: 2, ecc: "M", pixelSize: 8 });
  }, [pairing?.pairing?.qrValue]);
  const pairLinks = useMemo(() => pairingDeepLinks(pairing?.pairing?.qrValue), [pairing?.pairing?.qrValue]);
  const hasRoutePairLinks = Boolean(pairLinks.lan || pairLinks.tailnet || pairLinks.default);

  const relayHost = relayHostLabel(pairing?.pairing?.relay ?? pairing?.relay ?? null);
  const expiresIn = formatExpiresIn(pairing?.pairing?.expiresAt, now);
  const connectedPeer = pairing?.trustedPeers.find((peer) => peer.fingerprint === pairing.connectedPeerFingerprint) ?? null;
  const connectedPeerName = connectedPeer?.name ?? shortFingerprint(pairing?.connectedPeerFingerprint ?? null);
  const tone = pairingTone(pairing);
  const nameDirty = userName.trim() !== savedName;

  const showInitialError = !loading && !pairing && Boolean(pairingError);

  return (
    <div className="sys-surface-page sys-settings-page">
      <div className="sys-page-head">
        <div className="sys-page-title-group">
          <h2 className="sys-page-title">Settings</h2>
          <p className="sys-page-subtitle">
            Identity, pairing, and trusted devices.
          </p>
        </div>
        <div className="sys-page-actions">
          {pairing && <StatusPill tone={tone}>{pairing.statusLabel}</StatusPill>}
          <div className="sys-sync-note">
            {loading
              ? "Loading..."
              : pairingError && pairing
                ? `Snapshot from ${lastLoadedAt ? timeAgo(lastLoadedAt) : "earlier"}`
                : lastLoadedAt
                  ? `Updated ${timeAgo(lastLoadedAt)}`
                  : ""}
          </div>
          <button
            type="button"
            className="s-btn"
            disabled={loading || refreshing || Boolean(controlBusy)}
            onClick={() => void loadPairing("manual")}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {pairingError && pairing && (
        <div className="sys-banner sys-banner-warning">
          <strong>Refresh failed.</strong>
          <span>{pairingError}</span>
        </div>
      )}

      {identityError && (
        <div className="sys-banner sys-banner-warning">
          <strong>Identity error.</strong>
          <span>{identityError}</span>
        </div>
      )}

      {loading && !pairing && (
        <EmptyState
          title="Loading settings"
          body="Checking relay status and trusted peers."
        />
      )}

      {showInitialError && (
        <EmptyState
          className="sys-state-card-error"
          title="Pairing unavailable"
          body={pairingError}
          action={
            <button type="button" className="s-btn" onClick={() => void loadPairing("manual")}>
              Try again
            </button>
          }
        />
      )}

      {/* ── Top row: QR + Identity/Status ── */}
      <div className="sys-settings-hero">
        {/* QR block */}
        <div className="sys-settings-qr-col">
          {qrSvg ? (
            <div className="sys-settings-qr-frame">
              <div className="s-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
              {expiresIn && <span className="sys-settings-qr-expires">Expires in {expiresIn}</span>}
            </div>
          ) : (
            <div className="sys-settings-qr-empty">
              <span className="sys-settings-qr-empty-label">Generating QR...</span>
            </div>
          )}
        </div>

        {/* Identity + relay + controls */}
        <div className="sys-settings-info-col">
          {/* Name input */}
          <div className="sys-input-row">
            <input
              className="sys-input"
              type="text"
              placeholder="Your name"
              value={userName}
              onChange={(event) => setUserName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && nameDirty && !savingName) {
                  void saveName();
                }
              }}
            />
            <button
              type="button"
              className="s-btn s-btn-primary"
              disabled={!nameDirty || savingName}
              onClick={() => void saveName()}
            >
              {savingName ? "Saving..." : "Save"}
            </button>
          </div>

          {/* Key details — single-line each */}
          <div className="sys-settings-kv-list">
            {pairing?.identityFingerprint && (
              <div className="sys-settings-kv">
                <span className="sys-settings-kv-label">Fingerprint</span>
                <span className="sys-settings-kv-value">
                  <code>{pairing.identityFingerprint}</code>
                  <CopyButton value={pairing.identityFingerprint} />
                </span>
              </div>
            )}
            {relayHost && (
              <div className="sys-settings-kv">
                <span className="sys-settings-kv-label">Relay</span>
                <span className="sys-settings-kv-value">
                  <code>{relayHost}</code>
                  <CopyButton value={relayHost} />
                </span>
              </div>
            )}
            {hasRoutePairLinks && (
              <div className="sys-settings-kv">
                <span className="sys-settings-kv-label">Links</span>
                <span className="sys-settings-kv-value sys-settings-link-list">
                  {pairLinks.lan && <PairRouteLink label="LAN" value={pairLinks.lan} />}
                  {pairLinks.tailnet && <PairRouteLink label="TSN" value={pairLinks.tailnet} />}
                  {!pairLinks.lan && !pairLinks.tailnet && pairLinks.default && (
                    <PairRouteLink label="PAIR" value={pairLinks.default} />
                  )}
                </span>
              </div>
            )}
            {pairing?.statusDetail && (
              <div className="sys-settings-kv">
                <span className="sys-settings-kv-label">Status</span>
                <span className="sys-settings-kv-value sys-settings-kv-nowrap">{pairing.statusDetail}</span>
              </div>
            )}
            {connectedPeerName && (
              <div className="sys-settings-kv">
                <span className="sys-settings-kv-label">Connected</span>
                <span className="sys-settings-kv-value">{connectedPeerName}</span>
              </div>
            )}
            {pairing?.secure && (
              <div className="sys-settings-kv">
                <span className="sys-settings-kv-label">Security</span>
                <span className="sys-settings-kv-value">
                  <StatusPill tone="success">Noise XX</StatusPill>
                </span>
              </div>
            )}
          </div>

          {/* Pairing controls */}
          {pairing && (
            <div className="sys-inline-actions sys-settings-controls">
              {pairing.isRunning ? (
                <>
                  <button
                    type="button"
                    className="s-btn"
                    disabled={Boolean(controlBusy)}
                    onClick={() => void control("restart")}
                  >
                    {controlBusy === "restart" ? "Restarting..." : "Restart"}
                  </button>
                  <button
                    type="button"
                    className="s-btn"
                    disabled={Boolean(controlBusy)}
                    onClick={() => void control("stop")}
                  >
                    {controlBusy === "stop" ? "Stopping..." : "Stop"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="s-btn s-btn-primary"
                  disabled={Boolean(controlBusy)}
                  onClick={() => void control("start")}
                >
                  {controlBusy === "start" ? "Starting..." : "Start pairing"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Trusted peers table ── */}
      {pairing && (
        <section className="sys-settings-peers" id="trusted-peers">
          <div className="sys-section-head">
            <div>
              <h3 className="sys-section-title">Trusted peers</h3>
              <p className="sys-section-subtitle">
                {pairing.trustedPeers.length} device{pairing.trustedPeers.length !== 1 ? "s" : ""} paired with this broker.
              </p>
            </div>
          </div>

          {pairing.trustedPeers.length === 0 ? (
            <div className="sys-list-empty">
              <h3>No trusted peers</h3>
              <p>Devices appear here after completing pairing.</p>
            </div>
          ) : (
            <table className="sys-peers-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Fingerprint</th>
                  <th>Paired</th>
                  <th>Last seen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pairing.trustedPeers.map((peer) => {
                  const isConnected = peer.fingerprint === pairing.connectedPeerFingerprint;
                  return (
                    <tr key={peer.fingerprint} className={isConnected ? "sys-peers-row-connected" : ""}>
                      <td>
                        <span className="sys-peers-name">
                          {peer.name ?? shortFingerprint(peer.fingerprint) ?? "Peer"}
                          {isConnected && <StatusPill tone="success" className="sys-peers-badge">Connected</StatusPill>}
                        </span>
                      </td>
                      <td>
                        <code className="sys-peers-fp">{peer.fingerprint}</code>
                      </td>
                      <td>{peer.pairedAtLabel ?? "—"}</td>
                      <td>{peer.lastSeenLabel ?? "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="sys-peers-remove"
                          disabled={removingPeer === peer.fingerprint}
                          onClick={() => void removePeer(peer.fingerprint)}
                          title="Remove peer"
                        >
                          {removingPeer === peer.fingerprint ? "..." : "Remove"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
