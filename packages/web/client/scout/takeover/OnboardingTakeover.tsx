import { useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { useScout } from "../Provider.tsx";
import { friendlyOnboardingError } from "./onboarding-errors.ts";
import { OnboardingHarnessPicker, onboardingHarnessDefault } from "./OnboardingHarnessPicker.tsx";

const TOTAL_STEPS = 4;

/* ── Top-level takeover — picks the first unresolved step and renders it ─── */
export function OnboardingTakeover() {
  const { onboarding } = useScout();
  if (!onboarding) return null;

  if (!onboarding.hasLocalConfig) return <Frame><PortsStep step={1} /></Frame>;
  if (!onboarding.hasOperatorName) return <Frame><NameStep step={2} /></Frame>;
  if (!onboarding.hasProjectConfig) return <Frame><ProjectStep step={3} /></Frame>;
  // `needed === true` only comes from a real /api/onboarding/state response;
  // a missing `needed` means we are looking at a client-side placeholder and
  // must not take over the app.
  if (onboarding.needed === true && (!onboarding.brokerReachable || !onboarding.hasReadyRuntime)) {
    return <Frame><SetupStep step={4} /></Frame>;
  }
  return null;
}

/* ── Status panel — the same chrome, for hosts that wait on the state read ── */
export function OnboardingNotice({
  title,
  description,
  error,
  action,
  onAction,
  busy,
}: {
  title: string;
  description: ReactNode;
  error?: string | null;
  action?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  return (
    <Frame>
      <Header eyebrow="First-run setup" title={title} description={description} />
      <ErrorBanner message={error ?? null} />
      {action && onAction ? (
        <div>
          <button
            type="button"
            onClick={onAction}
            disabled={busy}
            style={{ ...primaryButtonStyle, opacity: busy ? 0.5 : 1, cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "Working…" : action}
          </button>
        </div>
      ) : null}
    </Frame>
  );
}

/* ── Shared chrome — centered card, skip button is wired from each step ──── */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        overflow: "auto",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          margin: "auto",
          flexShrink: 0,
          padding: "clamp(28px, 6vw, 80px) clamp(24px, 6vw, 72px)",
          display: "flex",
          flexDirection: "column",
          gap: 40,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Header({ eyebrow, title, description }: { eyebrow: string; title: string; description: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={eyebrowStyle}>{eyebrow}</div>
      <h1 style={{ ...titleStyle, margin: 0 }}>{title}</h1>
      <div style={descStyle}>{description}</div>
    </div>
  );
}

function Actions({
  primary,
  onPrimary,
  primaryDisabled,
  busy,
}: {
  primary: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  busy?: boolean;
}) {
  const { skipOnboarding, onboardingError } = useScout();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <button
          type="button"
          onClick={onPrimary}
          disabled={primaryDisabled || busy}
          style={{
            ...primaryButtonStyle,
            opacity: primaryDisabled || busy ? 0.5 : 1,
            cursor: primaryDisabled || busy ? "default" : "pointer",
          }}
        >
          {busy ? "Working…" : primary}
        </button>
        <button
          type="button"
          onClick={skipOnboarding}
          style={skipLinkStyle}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--hud-ink)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--hud-muted)"; }}
        >
          Set up later
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--hud-muted)", lineHeight: 1.5 }}>
        Scout stays limited until setup finishes.
      </div>
      {onboardingError?.kind === "skip" ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--hud-status-error)", lineHeight: 1.5 }}>
          Couldn't save "Set up later". {onboardingError.message}
        </div>
      ) : null}
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid color-mix(in srgb, var(--hud-status-error) 35%, transparent)",
        backgroundColor: "color-mix(in srgb, var(--hud-status-error) 8%, transparent)",
        color: "var(--hud-status-error)",
        padding: "12px 16px",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {message}
    </div>
  );
}

/* ── Step 0 — write ~/.openscout/config.json (ports) ────────────────────── */
function PortsStep({ step }: { step: number }) {
  const { onboarding, refreshOnboarding } = useScout();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/onboarding/init", { method: "POST", body: "{}" });
      await refreshOnboarding();
    } catch (err) {
      setError(friendlyOnboardingError("init", err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header
        eyebrow={`First-run setup · Step ${step} of ${TOTAL_STEPS}`}
        title="Welcome to Scout"
        description="Start with local settings, then choose your project folders and a coding agent. No Scout account or vault access is needed."
      />
      <ul style={checklistStyle}>
        <Row
          label="Local Scout settings"
          done={false}
          hint="missing"
        />
        <Row
          label="Project folder"
          done={Boolean(onboarding?.hasProjectConfig)}
          hint={onboarding?.hasProjectConfig ? onboarding.projectRoot ?? undefined : "checked after setup"}
        />
      </ul>
      <ErrorBanner message={error} />
      <Actions primary="Set up this Mac" onPrimary={() => { void run(); }} busy={busy} />
    </>
  );
}

/* ── Step 1 — operator name (writes user.json) ──────────────────────────── */
function NameStep({ step }: { step: number }) {
  const { onboarding, refreshOnboarding } = useScout();
  const suggestion = onboarding?.operatorNameSuggestion ?? "";
  const [name, setName] = useState(suggestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Name is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await api("/api/user", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      await refreshOnboarding();
    } catch (err) {
      setError(friendlyOnboardingError("identity", err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header
        eyebrow={`Identity · Step ${step} of ${TOTAL_STEPS}`}
        title="What should we call you?"
        description="Your name shows up on messages you send and in any agent that speaks for you. You can change it later in Settings."
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label htmlFor="scout-onboarding-name" style={labelStyle}>Your name</label>
        <input
          id="scout-onboarding-name"
          autoFocus
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) { void run(); } }}
          placeholder={suggestion || "Operator"}
          style={inputStyle}
        />
        {suggestion ? (
          <div style={{ fontSize: 11, color: "var(--hud-muted)", fontFamily: "var(--hud-font-mono)" }}>
            Prefilled from your machine.
          </div>
        ) : null}
      </div>
      <ErrorBanner message={error} />
      <Actions primary="Continue" onPrimary={() => { void run(); }} busy={busy} primaryDisabled={!name.trim()} />
    </>
  );
}

/* ── Step 2 — source roots + harness ────────────────────────────────────── */
function ProjectStep({ step }: { step: number }) {
  const { onboarding, refreshOnboarding } = useScout();
  const suggestedContext = onboarding?.contextRoot ?? onboarding?.projectRoot ?? onboarding?.currentDirectory ?? "";
  const placeholderPath = suggestedContext || "~/dev";
  const [roots, setRoots] = useState<string[]>(() => onboarding?.sourceRoots?.length ? [...onboarding.sourceRoots] : [placeholderPath]);
  const [contextRoot, setContextRoot] = useState<string>(suggestedContext);
  const [harness, setHarness] = useState(() => onboardingHarnessDefault(onboarding?.defaultHarness));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRootAt = (i: number, v: string) => {
    setRoots((current) => current.map((r, idx) => (idx === i ? v : r)));
  };
  const addRoot = () => setRoots((current) => [...current, ""]);
  const removeRoot = (i: number) => setRoots((current) => current.filter((_, idx) => idx !== i));

  const run = async () => {
    const cleanRoots = roots.map((r) => r.trim()).filter(Boolean);
    const cleanContext = contextRoot.trim();
    if (!cleanContext) { setError("Choose a workspace folder for Scout."); return; }
    setBusy(true);
    setError(null);
    try {
      await api("/api/onboarding/project", {
        method: "POST",
        body: JSON.stringify({
          contextRoot: cleanContext,
          sourceRoots: cleanRoots,
          defaultHarness: harness,
        }),
      });
      await refreshOnboarding();
    } catch (err) {
      setError(friendlyOnboardingError("project", err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header
        eyebrow={`Project · Step ${step} of ${TOTAL_STEPS}`}
        title="Where do your repos live?"
        description="Choose the folders Scout should look in for projects, where to save your workspace settings, and the coding agent you prefer."
      />

      <div style={sectionStyle}>
        <label style={labelStyle}>Scan folders</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {roots.map((root, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <input
                aria-label={`Scan folder ${i + 1}`}
                value={root}
                onChange={(e) => setRootAt(i, e.target.value)}
                placeholder={i === 0 ? placeholderPath : "Add another folder"}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={() => removeRoot(i)}
                disabled={roots.length <= 1}
                style={{
                  ...secondaryButtonStyle,
                  opacity: roots.length <= 1 ? 0.4 : 1,
                  cursor: roots.length <= 1 ? "default" : "pointer",
                }}
                aria-label={`Remove folder ${i + 1}`}
              >
                −
              </button>
            </div>
          ))}
          <button type="button" onClick={addRoot} style={{ ...secondaryButtonStyle, alignSelf: "flex-start" }}>
            + Add folder
          </button>
        </div>
      </div>

      <div style={sectionStyle}>
        <label htmlFor="scout-onboarding-context" style={labelStyle}>Workspace folder</label>
        <input
          id="scout-onboarding-context"
          value={contextRoot}
          onChange={(e) => setContextRoot(e.target.value)}
          placeholder={placeholderPath}
          style={inputStyle}
        />
        <div style={hintStyle}>
          Scout saves its project settings in this folder.
        </div>
        <div style={hintStyle}>Tip: ~ expands to your home folder.</div>
      </div>

      <OnboardingHarnessPicker value={harness} onChange={setHarness} observations={onboarding?.harnesses} />

      <ErrorBanner message={error} />
      <Actions
        primary="Save project settings"
        onPrimary={() => { void run(); }}
        busy={busy}
        primaryDisabled={!contextRoot.trim()}
      />
    </>
  );
}

/* Step 3: run setup and verify runtime readiness. */
function SetupStep({ step }: { step: number }) {
  const { onboarding, refreshOnboarding } = useScout();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ brokerWarning?: string | null; hasReadyRuntime?: boolean }>("/api/onboarding/setup", {
        method: "POST",
        body: "{}",
      });
      await refreshOnboarding();
      if (result.brokerWarning) {
        setError(friendlyOnboardingError("setup", result.brokerWarning));
      } else if (result.hasReadyRuntime === false) {
        setError("Scout couldn't find a ready coding agent. Install or sign in to your preferred tool, then choose Run setup again.");
      }
    } catch (err) {
      setError(friendlyOnboardingError("setup", err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header
        eyebrow={`Setup · Step ${step} of ${TOTAL_STEPS}`}
        title="Finish setup"
        description="Scout will connect your coding tools, start its local service, and check that an agent is ready for your first task."
      />
      <ul style={checklistStyle}>
        <Row
          label="Project settings"
          done={Boolean(onboarding?.hasProjectConfig)}
          hint={onboarding?.projectConfigPath ?? onboarding?.projectRoot ?? undefined}
        />
        <Row
          label="Scout's local service"
          done={Boolean(onboarding?.brokerReachable)}
          hint={onboarding?.brokerReachable ? "connected" : "starts when you run setup"}
        />
        <Row
          label="Coding agent"
          done={Boolean(onboarding?.hasReadyRuntime)}
          hint={onboarding?.hasReadyRuntime ? "ready" : "install or sign in to your preferred tool"}
        />
      </ul>
      <ErrorBanner message={error} />
      <Actions
        primary="Run setup"
        onPrimary={() => { void run(); }}
        busy={busy}
      />
    </>
  );
}

/* ── Small bits ─────────────────────────────────────────────────────────── */
function Row({ label, done, hint }: { label: string; done: boolean; hint?: string }) {
  return (
    <li style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
      <span
        style={{
          marginTop: 2,
          width: 20,
          height: 20,
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 700,
          flexShrink: 0,
          backgroundColor: done ? "color-mix(in srgb, var(--hud-status-ok) 15%, transparent)" : "var(--hud-surface)",
          color: done ? "var(--hud-status-ok)" : "var(--hud-muted)",
        }}
      >
        {done ? "✓" : "•"}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: done ? "var(--hud-muted)" : "var(--hud-ink)" }}>
          {label}
        </div>
        {hint ? (
          <div style={{ fontSize: 11, fontFamily: "var(--hud-font-mono)", color: "var(--hud-muted)", marginTop: 4, wordBreak: "break-all" }}>
            {hint}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────── */
const eyebrowStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--hud-font-mono)",
  textTransform: "uppercase",
  letterSpacing: "0.18em",
  color: "var(--hud-muted)",
};
const titleStyle: React.CSSProperties = {
  fontSize: "clamp(28px, 4vw, 36px)",
  fontWeight: 600,
  letterSpacing: "-0.01em",
  lineHeight: 1.15,
};
const descStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.75,
  color: "var(--hud-muted)",
  maxWidth: 580,
};
const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--hud-font-mono)",
  textTransform: "uppercase",
  letterSpacing: "0.15em",
  color: "var(--hud-muted)",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 14px",
  fontSize: 14,
  fontFamily: "var(--hud-font-mono)",
  color: "var(--hud-ink)",
  backgroundColor: "var(--hud-surface)",
  border: "1px solid var(--hud-border)",
  borderRadius: 8,
  boxSizing: "border-box",
};
const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--hud-muted)",
  lineHeight: 1.6,
};
const primaryButtonStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: "12px 24px",
  borderRadius: 10,
  backgroundColor: "var(--hud-accent)",
  color: "oklch(var(--accent-foreground))",
  border: "none",
  transition: "opacity 0.15s ease",
};
const secondaryButtonStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  padding: "10px 14px",
  borderRadius: 8,
  backgroundColor: "var(--hud-surface)",
  border: "1px solid var(--hud-border)",
  color: "var(--hud-ink)",
  transition: "all 0.15s ease",
};
const skipLinkStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--hud-muted)",
  textDecoration: "underline dotted var(--hud-muted)",
  textUnderlineOffset: 4,
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: "4px 2px",
  transition: "color 0.15s ease",
};
const checklistStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 20,
  margin: 0,
  padding: 0,
  listStyle: "none",
};
