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

const DOCS_URL = "https://openscout.app/docs";

export function TopRowIdentity({
  presentation = "scout",
}: {
  presentation?: "scout" | "slack";
}) {
  const { onboarding, refreshOnboarding } = useScout();
  const operator =
    onboarding?.operatorName?.trim()
    || onboarding?.operatorNameSuggestion?.trim()
    || null;

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
      {operator ? (
        <span
          className="scout-top-row-operator"
          title={operator}
          aria-label={`Operator ${operator}`}
        >
          {presentation === "slack"
            ? operator.slice(0, 1).toUpperCase()
            : `@${operator.toLowerCase()}`}
        </span>
      ) : null}
    </div>
  );
}
