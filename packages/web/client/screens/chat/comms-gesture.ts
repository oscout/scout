/**
 * The gestures a Comms drawing answers to.
 *
 * Inside a drawing a single click SELECTS: one thing at a time, shown in the
 * panel docked to the drawing. That is the whole vocabulary there — nothing in
 * a drawing is a conversation, so nothing in it can be put on the stage or
 * kept beside it by a gesture; the selection panel offers those as buttons.
 *
 * A conversation card (the strip above the stage) has two gestures: a click
 * puts it on the stage, and a double click — Shift+Enter from the keyboard,
 * which has no double click — keeps it beside.
 *
 * SVG is why `hit` exists as a helper at all: a `<g>` is not a control, so it
 * needs the role, the tab stop and the key handling written out by hand.
 */

type Keyed = { key: string; shiftKey: boolean; preventDefault: () => void };

/** For an SVG `<g>`, which the browser gives none of this to. */
export function hit(select: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: select,
    onKeyDown: (event: Keyed) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select();
    },
  };
}

/**
 * For a real `<button>`, which already fires onClick from Enter and Space —
 * so this adds only what the button does not do by itself.
 */
export function press(primary: () => void, secondary?: () => void) {
  return {
    onClick: primary,
    onDoubleClick: secondary,
    onKeyDown: (event: Keyed) => {
      if (!secondary || !event.shiftKey || event.key !== "Enter") return;
      event.preventDefault();
      secondary();
    },
  };
}
