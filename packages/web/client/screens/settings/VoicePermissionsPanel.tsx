import { useCallback, useEffect, useRef, useState } from "react";

import {
  openScoutVoicePrivacySettings,
  requestScoutVoicePermissions,
  type ScoutVoicePermissionStatus,
} from "../../lib/scout-voice.ts";

import "./voice-permissions-panel.css";

type VoicePermissionKind = "microphone" | "speechRecognition";

const PERMISSION_META: Record<VoicePermissionKind, {
  label: string;
  privacyPane: string;
  hint: string;
  appLabel: string;
}> = {
  microphone: {
    label: "Microphone",
    privacyPane: "Microphone",
    hint: "Scout Menu captures audio for web dictation. The browser never records.",
    appLabel: "Scout Menu",
  },
  speechRecognition: {
    label: "Speech recognition",
    privacyPane: "Speech Recognition",
    hint: "Live partials and Apple Speech fallback while Parakeet warms.",
    appLabel: "Scout Menu",
  },
};

function permissionTone(status: ScoutVoicePermissionStatus | null): "ok" | "warn" | "fail" | "idle" {
  if (!status) return "idle";
  if (status.granted) return "ok";
  if (status.canRequest) return "warn";
  if (status.status === "denied" || status.status === "restricted") return "fail";
  return "warn";
}

function permissionStatusLabel(status: ScoutVoicePermissionStatus | null): string {
  if (!status) return "Unknown";
  if (status.granted) return "Granted";
  switch (status.status) {
    case "notDetermined": return "Not requested";
    case "denied": return "Denied";
    case "restricted": return "Restricted";
    case "authorized": return "Granted";
    default: return status.status;
  }
}

function permissionDetail(status: ScoutVoicePermissionStatus | null, kind: VoicePermissionKind): string {
  if (!status) {
    return "Launch Scout Menu on this Mac, then refresh.";
  }
  if (status.granted) {
    return `${PERMISSION_META[kind].appLabel} is allowed to use ${PERMISSION_META[kind].label.toLowerCase()}.`;
  }
  if (status.canRequest) {
    return `Click Request to show the macOS permission dialog for ${PERMISSION_META[kind].appLabel}.`;
  }
  if (status.status === "denied") {
    return `Choose Retry access. Scout Menu will open macOS ${PERMISSION_META[kind].privacyPane} settings and detect the change automatically.`;
  }
  if (status.status === "restricted") {
    return `${PERMISSION_META[kind].label} access is restricted on this Mac.`;
  }
  return `${PERMISSION_META[kind].appLabel} needs ${PERMISSION_META[kind].label.toLowerCase()} access before dictation works.`;
}

function canOpenPermissionSettings(status: ScoutVoicePermissionStatus | null): boolean {
  return Boolean(status && !status.granted && !status.canRequest && status.status !== "unknown");
}

function canRetryPermission(status: ScoutVoicePermissionStatus | null): boolean {
  return Boolean(status && !status.granted && status.status !== "restricted" && status.status !== "unknown");
}

export function VoiceHostStatusBanner({
  hostOnline,
  micPermission,
  speechPermission,
  modelReady,
}: {
  hostOnline: boolean;
  micPermission: ScoutVoicePermissionStatus | null;
  speechPermission: ScoutVoicePermissionStatus | null;
  modelReady?: boolean;
}) {
  const micOk = micPermission?.granted ?? false;
  const speechOk = speechPermission?.granted ?? false;
  const ready = hostOnline && micOk && speechOk;

  let tone: "ok" | "warn" | "fail" = "fail";
  let headline = "Scout Menu not connected";
  let detail = "Launch Scout Menu on this Mac. Web dictation uses the Scout voice host — not the browser microphone.";

  if (hostOnline && !micOk && (micPermission?.status === "denied" || micPermission?.status === "restricted")) {
    tone = "fail";
    headline = "Microphone blocked for Scout Menu";
    detail = micPermission?.status === "restricted"
      ? "Microphone access is restricted on this Mac."
      : "Choose Retry access below. Scout will open the right macOS pane and detect the change.";
  } else if (hostOnline && !micOk && micPermission?.canRequest) {
    tone = "warn";
    headline = "Microphone access needed";
    detail = "Request permission below or tap the mic in chat. Scout Menu will show the macOS prompt.";
  } else if (hostOnline && micOk && !speechOk && (speechPermission?.status === "denied" || speechPermission?.status === "restricted")) {
    tone = "warn";
    headline = "Speech recognition blocked for Scout Menu";
    detail = speechPermission?.status === "restricted"
      ? "Speech recognition is restricted on this Mac."
      : "Open Privacy & Security → Speech Recognition to change it.";
  } else if (hostOnline && micOk && !speechOk) {
    tone = "warn";
    headline = "Speech recognition needed";
    detail = "Request access below or tap the mic in chat. Scout Menu will show the macOS prompt.";
  } else if (hostOnline && ready) {
    tone = "ok";
    headline = modelReady ? "Dictation ready" : "Dictation ready · model warming";
    detail = "Scout Menu is running as the voice host. The browser does not capture audio.";
  } else if (hostOnline) {
    tone = "warn";
    headline = "Voice host connected";
    detail = "Finish permissions below to enable dictation.";
  }

  return (
    <div className={`s-voice-host-banner s-voice-host-banner--${tone}`}>
      <div className="s-voice-host-banner-dot" aria-hidden />
      <div className="s-voice-host-banner-copy">
        <div className="s-voice-host-banner-title">{headline}</div>
        <div className="s-voice-host-banner-detail">{detail}</div>
        <div className="s-voice-host-banner-meta">
          <span>Voice host · Scout Menu</span>
          <span>{hostOnline ? "Connected" : "Offline"}</span>
          <span>Capture · native</span>
        </div>
      </div>
    </div>
  );
}

function VoicePermissionCard({
  kind,
  status,
  disabled,
  onActionError,
  onRefresh,
}: {
  kind: VoicePermissionKind;
  status: ScoutVoicePermissionStatus | null;
  disabled?: boolean;
  onActionError: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [acting, setActing] = useState(false);
  const statusRef = useRef(status);
  const meta = PERMISSION_META[kind];
  const tone = permissionTone(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const pollAfterRequest = useCallback(async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      await onRefresh();
      if (statusRef.current?.granted) return;
    }
  }, [onRefresh]);

  const requestAccess = useCallback(async () => {
    setActing(true);
    try {
      await requestScoutVoicePermissions(kind);
      await pollAfterRequest();
    } catch (error) {
      onActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActing(false);
    }
  }, [kind, onActionError, pollAfterRequest]);

  const openSettings = useCallback(async () => {
    setActing(true);
    try {
      await openScoutVoicePrivacySettings(kind);
    } catch (error) {
      onActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActing(false);
    }
  }, [kind, onActionError]);

  return (
    <div className={`s-voice-permission-card s-voice-permission-card--${tone}`}>
      <div className="s-voice-permission-card-head">
        <span className="s-voice-permission-card-dot" aria-hidden />
        <div>
          <div className="s-voice-permission-card-label">{meta.label}</div>
          <div className="s-voice-permission-card-app">via {meta.appLabel}</div>
        </div>
        <span className={`s-voice-permission-card-status s-voice-permission-card-status--${tone}`}>
          {permissionStatusLabel(status)}
        </span>
      </div>
      <p className="s-voice-permission-card-hint">{meta.hint}</p>
      <p className="s-voice-permission-card-detail">{permissionDetail(status, kind)}</p>
      <div className="s-voice-permission-card-actions">
        {canRetryPermission(status) ? (
          <button
            type="button"
            className="s-voice-permission-btn s-voice-permission-btn--primary"
            disabled={disabled || acting}
            onClick={() => void requestAccess()}
          >
            {acting
              ? (status?.canRequest ? "Requesting…" : "Waiting for macOS…")
              : (status?.canRequest ? "Request access" : "Retry access")}
          </button>
        ) : null}
        {canOpenPermissionSettings(status) ? (
          <button
            type="button"
            className="s-voice-permission-btn"
            disabled={disabled || acting}
            onClick={() => void openSettings()}
          >
            Open Privacy &amp; Security → {meta.privacyPane}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function VoicePermissionsPanel({
  permissions,
  hostOnline,
  disabled,
  onError,
  onRefresh,
}: {
  permissions: ScoutVoicePermissionStatus[] | undefined;
  hostOnline: boolean;
  disabled?: boolean;
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const micPermission = permissions?.find((entry) => entry.kind === "microphone") ?? null;
  const speechPermission = permissions?.find((entry) => entry.kind === "speechRecognition") ?? null;

  return (
    <div className="s-voice-permissions-panel">
      <VoicePermissionCard
        kind="microphone"
        status={hostOnline ? micPermission : null}
        disabled={disabled || !hostOnline}
        onActionError={onError}
        onRefresh={onRefresh}
      />
      <VoicePermissionCard
        kind="speechRecognition"
        status={hostOnline ? speechPermission : null}
        disabled={disabled || !hostOnline}
        onActionError={onError}
        onRefresh={onRefresh}
      />
      {!hostOnline ? (
        <p className="s-voice-permissions-offline">
          Scout Menu is not reporting to this web server. Permissions are managed on the Mac where Scout Menu runs.
        </p>
      ) : null}
    </div>
  );
}
