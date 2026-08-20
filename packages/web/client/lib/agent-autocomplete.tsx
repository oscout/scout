import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { actorColor } from "./colors.ts";
import { isComposerSendShortcut } from "./compose-shortcuts.ts";
import type { Agent } from "./types.ts";
import "./agent-autocomplete.css";

export type AgentAutocompleteAgent = Pick<Agent, "id" | "name" | "handle">;

function agentHandle(agent: AgentAutocompleteAgent): string {
  return agent.handle ?? agent.id;
}

function matches(agent: AgentAutocompleteAgent, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    agent.name.toLowerCase().includes(q) ||
    agentHandle(agent).toLowerCase().includes(q) ||
    agent.id.toLowerCase().includes(q)
  );
}

/* ── Headless hook ── */

export type UseAgentAutocompleteOptions = {
  agents: AgentAutocompleteAgent[];
  query: string;
  excludeIds?: ReadonlyArray<string>;
  maxResults?: number;
};

export type UseAgentAutocompleteResult = {
  filtered: AgentAutocompleteAgent[];
  highlightedIndex: number;
  setHighlightedIndex: (index: number) => void;
  moveHighlight: (delta: number) => void;
  resetHighlight: () => void;
};

export function useAgentAutocomplete({
  agents,
  query,
  excludeIds,
  maxResults = 50,
}: UseAgentAutocompleteOptions): UseAgentAutocompleteResult {
  const exclude = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);
  const filtered = useMemo(() => {
    const list = agents.filter(
      (a) => !exclude.has(a.id) && matches(a, query.trim()),
    );
    return list.slice(0, maxResults);
  }, [agents, exclude, query, maxResults]);

  const [highlightedIndex, setHighlightedIndex] = useState(0);

  useEffect(() => {
    setHighlightedIndex((prev) =>
      filtered.length === 0 ? 0 : Math.min(prev, filtered.length - 1),
    );
  }, [filtered]);

  const moveHighlight = useCallback(
    (delta: number) => {
      setHighlightedIndex((prev) => {
        if (filtered.length === 0) return 0;
        const next = (prev + delta + filtered.length) % filtered.length;
        return next;
      });
    },
    [filtered.length],
  );

  const resetHighlight = useCallback(() => setHighlightedIndex(0), []);

  return {
    filtered,
    highlightedIndex,
    setHighlightedIndex,
    moveHighlight,
    resetHighlight,
  };
}

/* ── Suggest list (visual) ── */

export type AgentSuggestListProps = {
  agents: AgentAutocompleteAgent[];
  highlightedIndex: number;
  onSelect: (agent: AgentAutocompleteAgent) => void;
  onHover?: (index: number) => void;
  emptyHint?: ReactNode;
  pendingId?: string | null;
  className?: string;
  id?: string;
};

export function AgentSuggestList({
  agents,
  highlightedIndex,
  onSelect,
  onHover,
  emptyHint,
  pendingId,
  className,
  id,
}: AgentSuggestListProps) {
  if (agents.length === 0) {
    return (
      <div className={`agent-autocomplete ${className ?? ""}`} id={id}>
        <div className="agent-autocomplete-empty">
          {emptyHint ?? "No matches."}
        </div>
      </div>
    );
  }

  return (
    <div className={`agent-autocomplete ${className ?? ""}`} role="listbox" id={id}>
      {agents.map((a, i) => {
        const handle = agentHandle(a);
        const active = i === highlightedIndex;
        return (
          <button
            key={a.id}
            type="button"
            role="option"
            aria-selected={active}
            className={`agent-autocomplete-item${active ? " is-active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(a);
            }}
            onMouseEnter={() => onHover?.(i)}
            disabled={pendingId === a.id}
          >
            <div
              className="agent-autocomplete-avatar"
              style={{ background: actorColor(a.name) }}
            >
              {a.name[0]?.toUpperCase() ?? "?"}
            </div>
            <div className="agent-autocomplete-info">
              <span className="agent-autocomplete-name">{a.name}</span>
              <span className="agent-autocomplete-handle">@{handle}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ── Picker (input + popover) ── */

export type AgentPickerProps = {
  agents: AgentAutocompleteAgent[];
  excludeIds?: ReadonlyArray<string>;
  open: boolean;
  onClose: () => void;
  onSelect: (agent: AgentAutocompleteAgent) => void | Promise<void>;
  placeholder?: string;
  emptyHint?: ReactNode;
  pendingId?: string | null;
  anchor?: "below-right" | "below-left";
  className?: string;
  /** Ref to the trigger element so a mousedown on it doesn't fire click-outside. */
  triggerRef?: RefObject<HTMLElement | null>;
};

export function AgentPicker({
  agents,
  excludeIds,
  open,
  onClose,
  onSelect,
  placeholder = "Search agents…",
  emptyHint,
  pendingId,
  anchor = "below-right",
  className,
  triggerRef,
}: AgentPickerProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { filtered, highlightedIndex, setHighlightedIndex, moveHighlight } =
    useAgentAutocomplete({ agents, query, excludeIds });

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    queueMicrotask(() => inputRef.current?.focus());
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === "Enter") {
      const target = filtered[highlightedIndex];
      if (target) {
        e.preventDefault();
        void onSelect(target);
      }
    }
  };

  return (
    <div
      ref={wrapRef}
      className={`agent-picker agent-picker--${anchor} ${className ?? ""}`}
    >
      <input
        ref={inputRef}
        className="agent-picker-search"
        placeholder={placeholder}
        value={query}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-autocomplete="list"
      />
      <AgentSuggestList
        agents={filtered}
        highlightedIndex={highlightedIndex}
        onSelect={(agent) => void onSelect(agent)}
        onHover={setHighlightedIndex}
        emptyHint={emptyHint}
        pendingId={pendingId}
      />
    </div>
  );
}

/* ── @mention textarea ── */

const MENTION_PATTERN = /(^|\s)@([a-zA-Z0-9_.-]*)$/;

type MentionMatch = {
  start: number;
  end: number;
  query: string;
};

type PopoverPosition = {
  top: number;
  left: number;
};

const MENTION_POPOVER_GAP = 4;
const MENTION_POPOVER_FALLBACK_HEIGHT = 254;

function findMentionAtCaret(text: string, caret: number): MentionMatch | null {
  if (caret <= 0) return null;
  const before = text.slice(0, caret);
  const m = MENTION_PATTERN.exec(before);
  if (!m) return null;
  const leading = m[1] ?? "";
  const query = m[2] ?? "";
  const start = before.length - query.length - 1; // position of "@"
  if (start < 0) return null;
  // ensure caret is at end of mention token
  const after = text.slice(caret, caret + 1);
  if (after && !/\s/.test(after) && /[a-zA-Z0-9_.-]/.test(after)) {
    // caret is mid-token, still valid; re-measure end
  }
  return { start, end: caret, query };
}

/* Mirror-div caret position trick. Returns caret pixel offset relative to
 * the textarea's top-left (accounting for scroll). */
const MIRROR_STYLE_PROPS = [
  "boxSizing",
  "width",
  "height",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "whiteSpace",
  "wordWrap",
  "wordBreak",
] as const;

function caretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number; height: number } {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const style = div.style;
  const computed = window.getComputedStyle(textarea);
  style.position = "absolute";
  style.visibility = "hidden";
  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  style.top = "0";
  style.left = "-9999px";
  for (const prop of MIRROR_STYLE_PROPS) {
    style[prop as never] = computed[prop as never] as never;
  }
  div.textContent = textarea.value.slice(0, position);
  const span = document.createElement("span");
  span.textContent = textarea.value.slice(position) || ".";
  div.appendChild(span);
  const top = span.offsetTop;
  const left = span.offsetLeft;
  const height = parseInt(computed.lineHeight, 10) || span.offsetHeight;
  document.body.removeChild(div);
  return { top, left, height };
}

export type AgentMentionTextareaHandle = {
  focus: () => void;
  blur: () => void;
  textarea: HTMLTextAreaElement | null;
};

export type AgentMentionTextareaProps = {
  agents: AgentAutocompleteAgent[];
  excludeIds?: ReadonlyArray<string>;
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  submitOnEnter?: boolean;
  className?: string;
  textareaClassName?: string;
  emptyHint?: ReactNode;
  /** Called whenever a mention is inserted (for analytics / side-effects). */
  onMention?: (agent: AgentAutocompleteAgent) => void;
};

export const AgentMentionTextarea = forwardRef<
  AgentMentionTextareaHandle,
  AgentMentionTextareaProps
>(function AgentMentionTextarea(
  {
    agents,
    excludeIds,
    value,
    onChange,
    onSubmit,
    placeholder,
    rows = 1,
    disabled,
    submitOnEnter = false,
    className,
    textareaClassName,
    emptyHint,
    onMention,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      blur: () => textareaRef.current?.blur(),
      get textarea() {
        return textareaRef.current;
      },
    }),
    [],
  );

  const query = mention?.query ?? "";
  const { filtered, highlightedIndex, setHighlightedIndex, moveHighlight } =
    useAgentAutocomplete({ agents, query, excludeIds });

  const resizeTextarea = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    const computed = window.getComputedStyle(node);
    const minHeight = parseFloat(computed.minHeight) || 0;
    const maxHeight = parseFloat(computed.maxHeight);
    node.style.height = "0px";
    const naturalHeight = Math.max(node.scrollHeight, minHeight);
    const nextHeight =
      Number.isFinite(maxHeight) && maxHeight > 0
        ? Math.min(naturalHeight, maxHeight)
        : naturalHeight;
    node.style.height = `${nextHeight}px`;
    node.style.overflowY = naturalHeight > nextHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, value]);

  const refreshMention = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const next = findMentionAtCaret(ta.value, ta.selectionStart ?? 0);
    setMention(next);
  }, []);

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !mention) {
      setPopoverPos(null);
      return;
    }
    const { top, left, height } = caretCoordinates(ta, mention.start);
    const containerRect = ta.getBoundingClientRect();
    const wrap = ta.parentElement?.getBoundingClientRect();
    const offsetTop = wrap ? containerRect.top - wrap.top : 0;
    const offsetLeft = wrap ? containerRect.left - wrap.left : 0;
    const popoverHeight = popoverRef.current?.offsetHeight || MENTION_POPOVER_FALLBACK_HEIGHT;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const caretViewportTop = containerRect.top + top - ta.scrollTop;
    const caretViewportBottom = caretViewportTop + height;
    const spaceBelow = viewportBottom - caretViewportBottom - MENTION_POPOVER_GAP;
    const spaceAbove = caretViewportTop - viewportTop - MENTION_POPOVER_GAP;
    const placeAbove = spaceBelow < popoverHeight && spaceAbove > spaceBelow;
    setPopoverPos({
      top: placeAbove
        ? offsetTop + top - ta.scrollTop - popoverHeight - MENTION_POPOVER_GAP
        : offsetTop + top + height - ta.scrollTop + MENTION_POPOVER_GAP,
      left: offsetLeft + left - ta.scrollLeft,
    });
  }, [mention, value, filtered.length]);

  const insertMention = useCallback(
    (agent: AgentAutocompleteAgent) => {
      const ta = textareaRef.current;
      const current = mention;
      if (!ta || !current) return;
      const handle = agentHandle(agent);
      const before = value.slice(0, current.start);
      const after = value.slice(current.end);
      const replacement = `@${handle} `;
      const nextValue = `${before}${replacement}${after}`;
      onChange(nextValue);
      onMention?.(agent);
      setMention(null);
      const nextCaret = current.start + replacement.length;
      queueMicrotask(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [mention, value, onChange, onMention],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const submitRequested = isComposerSendShortcut(e)
      || (
        submitOnEnter
        && e.key === "Enter"
        && !e.shiftKey
        && !e.nativeEvent?.isComposing
        && !(mention && filtered.length > 0)
      );
    if (submitRequested) {
      e.preventDefault();
      onSubmit?.();
      return;
    }

    if (mention && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveHighlight(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveHighlight(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (e.key === "Enter" && e.shiftKey) return;
        const target = filtered[highlightedIndex];
        if (target) {
          e.preventDefault();
          insertMention(target);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
  };

  return (
    <div className={`agent-mention-wrap ${className ?? ""}`}>
      <textarea
        ref={textareaRef}
        className={textareaClassName}
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          resizeTextarea();
          // defer until value reflects new state in DOM
          queueMicrotask(refreshMention);
        }}
        onKeyUp={refreshMention}
        onClick={refreshMention}
        onBlur={() => setMention(null)}
        onKeyDown={handleKeyDown}
        aria-autocomplete="list"
      />
      {mention && (
        <div
          ref={popoverRef}
          className="agent-mention-popover"
          style={
            {
              top: `${popoverPos?.top ?? 0}px`,
              left: `${popoverPos?.left ?? 0}px`,
              visibility: popoverPos ? undefined : "hidden",
            } satisfies CSSProperties
          }
        >
          <AgentSuggestList
            agents={filtered}
            highlightedIndex={highlightedIndex}
            onSelect={insertMention}
            onHover={setHighlightedIndex}
            emptyHint={emptyHint ?? "No matches."}
          />
        </div>
      )}
    </div>
  );
});
