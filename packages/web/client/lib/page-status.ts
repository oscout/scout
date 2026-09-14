import { useEffect } from "react";
import { useSyncExternalStore } from "react";

export type PageStatusHover = {
  /** Internal SPA route or path-like string. */
  route?: string;
  /** Optional friendlier label, shown alongside or instead of route. */
  label?: string;
};

type Listener = () => void;

type State = {
  hover: PageStatusHover | null;
  content: string | null;
};

let state: State = { hover: null, content: null };
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): State {
  return state;
}

export function usePageStatusState(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Callers build the hover object inline per render, so the object that was set
 * on pointer-enter is rarely the one in hand on pointer-leave; a leave that
 * only cleared on identity left the bar stuck on a stale destination.
 */
function sameHover(a: PageStatusHover | null, b: PageStatusHover | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.route === b.route && a.label === b.label;
}

export function setPageStatusHover(hover: PageStatusHover | null) {
  if (state.hover === hover) return;
  state = { ...state, hover };
  emit();
}

export function setPageStatusContent(content: string | null) {
  if (state.content === content) return;
  state = { ...state, content };
  emit();
}

/**
 * Build pointer handlers that show a destination preview in the page status
 * bar on hover. Not a hook — safe to call inline from JSX.
 */
export function statusOnHover(hover: PageStatusHover | null | undefined) {
  if (!hover || (!hover.route && !hover.label)) {
    return { onPointerEnter: undefined, onPointerLeave: undefined };
  }
  return {
    onPointerEnter: () => setPageStatusHover(hover),
    onPointerLeave: () => {
      if (sameHover(state.hover, hover)) setPageStatusHover(null);
    },
  };
}

/**
 * Register page-scoped status content (right-side of the bar). Cleared on
 * unmount or when the content changes back to null.
 */
export function usePageStatusContent(content: string | null) {
  useEffect(() => {
    setPageStatusContent(content);
    return () => {
      setPageStatusContent(null);
    };
  }, [content]);
}
