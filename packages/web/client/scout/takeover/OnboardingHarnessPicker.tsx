import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";
import { HarnessMark } from "../../components/HarnessMark.tsx";

export type OnboardingHarnessObservation = {
  id: string;
  label: string;
  state: string;
  ready: boolean;
  detail: string;
};

/** The same visible choices as Scout's task composer, without duplicate transports. */
export const ONBOARDING_HARNESSES = SCOUT_RUNTIME_CATALOG.harnesses.filter(
  (entry) => entry.enabled && entry.listed !== false,
);

export function onboardingHarnessDefault(preferred?: string): string {
  // Older settings store `grok`; the picker exposes its current ACP transport.
  const visiblePreferred = preferred === "grok" ? "grok-acp" : preferred;
  return ONBOARDING_HARNESSES.find((entry) => entry.id === visiblePreferred)?.id
    ?? ONBOARDING_HARNESSES.find((entry) => entry.default)?.id
    ?? ONBOARDING_HARNESSES[0]?.id
    ?? "";
}

export function onboardingHarnessStatus(observed?: OnboardingHarnessObservation): string {
  if (!observed) return "Not checked";
  if (observed.ready) return "Ready";
  if (observed.state === "missing") return "Not installed";
  if (observed.state === "installed" || observed.state === "configured") return "Needs setup";
  return "Not checked";
}

export function OnboardingHarnessPicker({
  value, onChange, observations,
}: {
  value: string;
  onChange: (harness: string) => void;
  observations?: OnboardingHarnessObservation[];
}) {
  const selected = observations?.find((entry) => entry.id === value);
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Preferred coding agent</legend>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 8 }}>
        {ONBOARDING_HARNESSES.map((entry) => {
          const active = entry.id === value;
          const observed = observations?.find((candidate) => candidate.id === entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              data-harness={entry.id}
              aria-pressed={active}
              onClick={() => onChange(entry.id)}
              style={{
                display: "flex", alignItems: "center", gap: 14,
                minWidth: 0, padding: "12px 14px", textAlign: "left",
                borderRadius: 10, border: `1px solid ${active ? "var(--accent)" : "var(--hud-border)"}`,
                background: active ? "var(--hud-accent-soft)" : "var(--hud-surface)",
                color: "var(--hud-ink)", cursor: "pointer",
              }}
            >
              <HarnessMark harness={entry.id} size={26} title={null} style={{ flexShrink: 0 }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{entry.label}</span>
                <span style={{ fontSize: 12, color: "var(--hud-muted)" }}>{onboardingHarnessStatus(observed)}</span>
              </span>
              {active ? <span aria-hidden="true" style={{ fontSize: 15 }}>✓</span> : null}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 12, color: "var(--hud-muted)", lineHeight: 1.6, margin: "12px 0 0" }}>
        {selected?.detail || "Choose the tool you prefer. Scout checks its local setup before your first task."}
        {" "}You can choose a different agent for each task.
      </p>
    </fieldset>
  );
}
