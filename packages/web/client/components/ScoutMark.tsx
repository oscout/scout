/**
 * The Scout mark: a ring hexagon around a filled one.
 *
 * One definition, imported by every surface that draws the brand. It existed
 * twice — once in the sidebar header, once in the app shell's nav bar — and the
 * copies had already drifted: the sidebar's had been re-cropped so the mark
 * rendered at the size it claimed, and the shell's had not, so the same brand
 * was two different sizes two inches apart.
 *
 * COLOUR IS INHERITED, always. The shell's copy hardcoded a cream `#f8f3e8`
 * with a white glow behind it, which is a dark-theme value written as a
 * constant: on paper it was a pale mark bloomed by a white halo. A brand mark
 * has a colour in a palette, not a hex in a class name — so this paints in
 * `currentColor` and the surface decides, which is also the only way the mark
 * can sit in a rail, a nav bar and a light theme without three variants.
 */

/**
 * The viewBox is cropped to the ARTWORK, not to a round number.
 *
 * The outer hexagon spans x 5.2–14.8 inside a nominal `0 0 20 20`, so a mark
 * asked for 20px drew about 10 — narrower than the 16px nav icons beside it,
 * which is why the brand read as the smallest thing in its own chrome. Cropping
 * to the artwork plus a half-stroke makes the rendered size mean what it says,
 * so the mark grows without its row growing.
 */
const ARTWORK_BOX = "3.35 3.35 13.3 13.3";

export function ScoutMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox={ARTWORK_BOX}
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon
        points="10,4.3 14.8,7.1 14.8,12.9 10,15.7 5.2,12.9 5.2,7.1"
        strokeWidth="1.9"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <polygon
        points="10,7 12.4,8.4 12.4,10.6 10,12 7.6,10.6 7.6,8.4"
        strokeWidth="0.9"
        fill="currentColor"
        fillOpacity="0.9"
      />
    </svg>
  );
}
