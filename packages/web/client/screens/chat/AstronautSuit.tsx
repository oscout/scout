/**
 * The suit — a shared body under every creature in the facepile.
 *
 * The coin becomes a helmet: the creature is what you see through the visor,
 * and below it a collar and shoulders every agent wears. It is drawn as its
 * OWN layer rather than as extra rows on the 7x7 sprite, which is the whole
 * point — the generator never changes, and a creature invented tomorrow drops
 * into the same body with no work.
 *
 * It also buys the density back. The suit carries no identity, so it is the
 * one part of a coin a neighbour may safely eat; that is what lets the lap go
 * to 20% while every head stays whole. See the invariant in
 * conversation-screen.css.
 *
 * Coordinates are a 42-unit square mapped onto the coin, so the shape scales
 * with `--fp-coin` and the helmet's own `overflow: hidden` does the cropping.
 */
export function AstronautSuit() {
  return (
    <svg className="s-thread-participant-suit" viewBox="0 0 42 42" aria-hidden="true">
      {/* Shoulders, running off the bottom of the helmet and cropped by its rim. */}
      <path
        d="M 21 30.5 C 31 30.5 40 34.5 41.5 42 L 0.5 42 C 2 34.5 11 30.5 21 30.5 Z"
        fill="var(--fp-suit)"
      />
      {/* The collar ring, which is what reads as "this head is attached". */}
      <rect x="15.5" y="26.5" width="11" height="4" rx="2" fill="var(--fp-suit-light)" />
      {/* Visor gloss. Kept under 10% or it reads as a scratch rather than glass. */}
      <path
        d="M 8.5 15 A 13 13 0 0 1 19 5.5"
        fill="none"
        stroke="var(--fp-visor)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
