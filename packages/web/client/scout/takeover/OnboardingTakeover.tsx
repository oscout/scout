import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { useScout } from "../Provider.tsx";
import { friendlyOnboardingError } from "./onboarding-errors.ts";

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

/* ── Shared chrome — centered card, skip button is wired from each step ──── */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
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
          padding: "80px 72px",
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
      <div style={titleStyle}>{title}</div>
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
  const { skipOnboarding } = useScout();
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
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.8)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.45)"; }}
        >
          Set up later
        </button>
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
        Scout stays limited until setup finishes.
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid rgba(239,68,68,0.35)",
        backgroundColor: "rgba(239,68,68,0.08)",
        color: "rgba(252,165,165,0.95)",
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
        description={
          <>
            Scout needs a local config before it can talk to the broker, the
            web app, and paired devices. This writes{" "}
            <code style={codeStyle}>~/.openscout/config.json</code> with
            sensible defaults — you can edit it any time.
          </>
        }
      />
      <ul style={checklistStyle}>
        <Row
          label="Local config (~/.openscout/config.json)"
          done={false}
          hint="missing"
        />
        <Row
          label=".openscout/project.json in a repo"
          done={Boolean(onboarding?.hasProjectConfig)}
          hint={onboarding?.hasProjectConfig ? onboarding.projectRoot ?? undefined : "checked after setup"}
        />
      </ul>
      <ErrorBanner message={error} />
      <Actions primary="Initialize Scout" onPrimary={() => { void run(); }} busy={busy} />
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

  // Sync suggestion once it lands (if component mounts before fetch resolves)
  useEffect(() => {
    if (!name && suggestion) setName(suggestion);
  }, [suggestion, name]);

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
        <label style={labelStyle}>Your name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { void run(); } }}
          placeholder={suggestion || "Operator"}
          style={inputStyle}
        />
        {suggestion ? (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "var(--hud-font-mono)" }}>
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
  const suggestedContext = onboarding?.currentDirectory ?? "";
  const placeholderPath = suggestedContext || "~/dev";
  const [roots, setRoots] = useState<string[]>([placeholderPath]);
  const [contextRoot, setContextRoot] = useState<string>(suggestedContext);
  const [harness, setHarness] = useState<"claude" | "codex">("claude");
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
    if (!cleanContext) { setError("Pick where Scout should anchor this context."); return; }
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
        description={
          <>
            Scout scans these folders for projects and anchors this context at{" "}
            <code style={codeStyle}>{"<context>/.openscout/project.json"}</code>.
          </>
        }
      />

      <div style={sectionStyle}>
        <label style={labelStyle}>Scan folders</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {roots.map((root, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <input
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
        <label style={labelStyle}>Context root</label>
        <input
          value={contextRoot}
          onChange={(e) => setContextRoot(e.target.value)}
          placeholder={placeholderPath}
          style={inputStyle}
        />
        <div style={hintStyle}>
          Scout writes <code style={codeStyle}>.openscout/project.json</code>{" "}
          inside this folder.
        </div>
        <div style={hintStyle}>Tip: ~ expands to your home folder.</div>
      </div>

      <div style={sectionStyle}>
        <label style={labelStyle}>Default harness</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {(["claude", "codex"] as const).map((h) => {
            const selected = harness === h;
            return (
              <button
                key={h}
                type="button"
                onClick={() => setHarness(h)}
                style={{
                  ...harnessCardStyle,
                  borderColor: selected ? "var(--accent, #2dd4bf)" : "rgba(255,255,255,0.12)",
                  backgroundColor: selected ? "rgba(45,212,191,0.08)" : "rgba(255,255,255,0.02)",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, textTransform: "capitalize" }}>{h}</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 6, lineHeight: 1.5 }}>
                  {h === "claude"
                    ? "Anthropic Claude Code — local CLI agent."
                    : "OpenAI Codex — cloud agentic sandbox."}
                </div>
                <div style={{ fontSize: 11, fontFamily: "var(--hud-font-mono)", color: "rgba(255,255,255,0.4)", marginTop: 8, lineHeight: 1.5 }}>
                  {h === "claude"
                    ? "Requires the Claude Code CLI, installed and signed in."
                    : "Requires the Codex CLI, installed and signed in."}
                </div>
              </button>
            );
          })}
        </div>
        <div style={hintStyle}>
          Not installed yet? Pick one anyway — the final step checks and tells you what's missing.
        </div>
      </div>

      <ErrorBanner message={error} />
      <Actions
        primary="Create project"
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
        setError("Setup finished, but Scout didn't find a ready agent runtime. Install or sign in to a supported runtime, then choose Run setup again.");
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
        description="Scout will install its harness skills, start the local broker, refresh discovery, and check for a ready agent runtime."
      />
      <ul style={checklistStyle}>
        <Row
          label=".openscout/project.json"
          done={Boolean(onboarding?.hasProjectConfig)}
          hint={onboarding?.projectConfigPath ?? onboarding?.projectRoot ?? undefined}
        />
        <Row
          label="Broker reachable"
          done={Boolean(onboarding?.brokerReachable)}
          hint={onboarding?.brokerReachable ? "connected" : "starts when you run setup"}
        />
        <Row
          label="Agent runtime"
          done={Boolean(onboarding?.hasReadyRuntime)}
          hint={onboarding?.hasReadyRuntime ? "ready" : "install or sign in to a supported runtime"}
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
          backgroundColor: done ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.07)",
          color: done ? "#4ade80" : "rgba(255,255,255,0.5)",
        }}
      >
        {done ? "✓" : "•"}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: done ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.9)" }}>
          {label}
        </div>
        {hint ? (
          <div style={{ fontSize: 11, fontFamily: "var(--hud-font-mono)", color: "rgba(255,255,255,0.35)", marginTop: 4, wordBreak: "break-all" }}>
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
  color: "rgba(255,255,255,0.4)",
};
const titleStyle: React.CSSProperties = {
  fontSize: 36,
  fontWeight: 600,
  letterSpacing: "-0.01em",
  lineHeight: 1.15,
};
const descStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.75,
  color: "rgba(255,255,255,0.6)",
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
  color: "rgba(255,255,255,0.5)",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 14px",
  fontSize: 14,
  fontFamily: "var(--hud-font-mono)",
  color: "rgba(255,255,255,0.92)",
  backgroundColor: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  outline: "none",
  boxSizing: "border-box",
};
const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.45)",
  lineHeight: 1.6,
};
const codeStyle: React.CSSProperties = {
  fontFamily: "var(--hud-font-mono)",
  fontSize: 12,
  padding: "2px 6px",
  borderRadius: 4,
  backgroundColor: "rgba(255,255,255,0.06)",
};
const primaryButtonStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: "12px 24px",
  borderRadius: 10,
  backgroundColor: "var(--accent, #2dd4bf)",
  color: "#0b0d12",
  border: "none",
  transition: "opacity 0.15s ease",
};
const secondaryButtonStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  padding: "10px 14px",
  borderRadius: 8,
  backgroundColor: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "rgba(255,255,255,0.85)",
  transition: "all 0.15s ease",
};
const skipLinkStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.45)",
  textDecoration: "underline dotted rgba(255,255,255,0.25)",
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
const harnessCardStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "16px 18px",
  borderRadius: 12,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(255,255,255,0.12)",
  color: "rgba(255,255,255,0.9)",
  cursor: "pointer",
  transition: "all 0.15s ease",
};
