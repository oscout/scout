import { goShortcutForKey } from "../lib/go-shortcuts.ts";
import { isEditableTarget, isModalShortcutContext, isTerminalInputTarget } from "../lib/keyboard-nav-core.ts";
import type { Route } from "../lib/types.ts";

/** The full web shell is absent in these embeds. WebKit owns its key stream,
 * so install the shared area chords here, with the same input exclusions. */
export function installNativeAreaKeyboard(navigate: (route: Route) => void): () => void {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { armed = false; clearTimeout(timer); };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
      || isEditableTarget(event.target) || isTerminalInputTarget(event.target)
      || isModalShortcutContext()) { clear(); return; }
    const key = event.key.toLowerCase();
    if (armed) {
      clear();
      const shortcut = "hcptdfolbr".includes(key) ? goShortcutForKey(key) : null;
      event.preventDefault();
      event.stopPropagation();
      if (shortcut) navigate(shortcut.route);
      return;
    }
    if (key === "g") {
      armed = true;
      timer = setTimeout(clear, 1500);
      event.preventDefault();
      event.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("blur", clear);
  window.addEventListener("focusin", clear);
  return () => {
    clear();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", clear);
    window.removeEventListener("focusin", clear);
  };
}
