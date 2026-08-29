import { Check } from "lucide-react";
import { CAST_MEMBERS, CREW_ASSETS_AVAILABLE, rendererCoverage } from "../lib/crew-registry.ts";
import { CrewAvatar } from "./CrewAvatar.tsx";
import "./CastPicker.css";

/**
 * CastPicker — the cast-mascot grid shared by the operator section and the
 * per-agent character assignment in agent configuration.
 *
 * One job: show the seven cast members and report the picked slug. The caller
 * owns what the choice means (operator identity vs. one agent's character) by
 * handling `onSelect`; the picker never writes appearance state itself.
 *
 * When crew artwork is unavailable (`CREW_ASSETS_AVAILABLE` false — release
 * builds without a configured pack URL), the grid renders nothing so callers
 * can fall back to their generative-identity treatment.
 */
export function CastPicker({
  selectedSlug,
  onSelect,
  size = 44,
}: {
  /** Currently chosen cast slug (case-insensitive match). */
  selectedSlug?: string | null;
  onSelect: (slug: string) => void;
  /** Avatar coin diameter inside each card. */
  size?: number;
}) {
  if (!CREW_ASSETS_AVAILABLE) return null;
  const coverage = rendererCoverage("crew");
  return (
    <div
      className="s-settings-cast-grid"
      role="group"
      aria-label="Character assignment"
    >
      {CAST_MEMBERS.map((member) => {
        const active = selectedSlug?.toLowerCase() === member.slug.toLowerCase();
        return (
          <button
            key={member.slug}
            type="button"
            className="s-settings-cast-choice"
            data-cast-slug={member.slug}
            data-active={active || undefined}
            aria-pressed={active}
            onClick={() => onSelect(member.slug)}
          >
            <CrewAvatar slug={member.slug} size={size} ring={active} state={active ? "working" : "idle"} />
            <span className="s-settings-cast-name">{member.name}</span>
            <span className="s-settings-cast-title">{member.title}</span>
            {active && <Check className="s-settings-cast-check" size={14} aria-hidden />}
          </button>
        );
      })}
      {coverage ? (
        <span className="s-cast-picker-coverage" aria-hidden>{coverage.covered} of {coverage.total} cast</span>
      ) : null}
    </div>
  );
}
