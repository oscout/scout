/**
 * Top-row right side: who you are, and the way out to the docs.
 *
 * These are the two facts that hold on every surface, so they belong to the app
 * frame rather than to whichever screen happens to be open. Home used to state
 * the operator itself, inside its hero — one screen speaking for the whole app.
 *
 * Deliberately not here: freshness ("updated now") and refresh. Those describe
 * one view's data and belong to that view. Nor the section links (terminal,
 * code, ops) — the nav rail already goes there, and a second path to the same
 * place is a second thing to keep in sync.
 */
import { useEffect, useRef } from "react";
import { CircleHelp } from "lucide-react";
import { useScout } from "../Provider.tsx";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";

const DOCS_URL = "https://openscout.app/docs";

export function TopRowIdentity({
  presentation = "scout",
}: {
  presentation?: "scout" | "slack";
}) {
  const { onboarding, operatorName, refreshOnboarding } = useScout();
  const operator =
    operatorName
    || onboarding?.operatorName?.trim()
    || onboarding?.operatorNameSuggestion?.trim()
    || null;

  /**
   * Did the name have to travel to get here?
   *
   * Captured on the first render and never updated: a name that was already in
   * the local cache is present in frame one and must not animate — motion on
   * something that was never missing is the pop-in again, just prettier. Only
   * the genuine first load, where the handle really does appear after the row
   * has settled, gets the entrance.
   */
  const arrivedLate = useRef(operator == null);

  // The provider fetches onboarding once on mount. A request that loses the
  // startup race falls back to a record with no name, and nothing asks again —
  // so the operator stays blank for the rest of the session. It only showed up
  // as a missing word inside Home's hero before; in the app frame it is missing
  // on every screen. Ask once more when we have a record but no name.
  const retried = useRef(false);
  useEffect(() => {
    if (operator || !onboarding || retried.current) return;
    retried.current = true;
    void refreshOnboarding();
  }, [onboarding, operator, refreshOnboarding]);

  return (
    <div className="scout-top-row-identity" data-presentation={presentation}>
      {/* Docs sits inboard of the name: the operator is the outermost, most
          stable thing in the frame, and the handle carries its own label — an
          "operator" eyebrow in front of an @ says the same word twice. */}
      <a
        className="scout-top-row-docs"
        href={DOCS_URL}
        target="_blank"
        rel="noreferrer"
        title="OpenScout documentation"
      >
        {presentation === "slack" ? (
          <CircleHelp size={16} strokeWidth={1.8} aria-hidden />
        ) : "docs"}
      </a>
      {/* The face IS the identity here, so the Slack presentation shows the
          coin alone. It used to draw Slack's monogram tile — a teal rounded
          square with an initial — with the avatar added on top of it later:
          two portraits of the same person in a 25px box, one of them clipped
          by it.

          The coin renders unconditionally, before any name is known, because
          it does not need one: the chosen character lives in the local
          appearance record and is available on the first frame. Only the
          handle waits, and only on a first visit. Gating the whole block on
          the name meant your own face was the last thing to load in your own
          workspace. */}
      <span
        className="scout-top-row-operator"
        title={operator ?? undefined}
        aria-label={operator ? `Operator ${operator}` : "Operator"}
      >
        <AgentAvatar name={operator ?? "operator"} size={28} presence={false} scaleWithPreference={false} />
        {presentation === "slack" ? null : (
          <span
            className="scout-top-row-handle"
            data-arriving={operator == null || undefined}
            data-arrived={operator != null && arrivedLate.current ? "" : undefined}
          >
            {operator ? `@${operator.toLowerCase()}` : null}
          </span>
        )}
      </span>
    </div>
  );
}
