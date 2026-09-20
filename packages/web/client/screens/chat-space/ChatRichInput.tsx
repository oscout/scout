import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  deleteCharsBeforeCaret,
  htmlToMarkdown,
  insertTextAtCaret,
  markdownToHtml,
  textBeforeCaret,
} from "./chat-rich-text.ts";

export type ChatRichInputHandle = {
  focus: () => void;
  textBeforeCaret: () => string;
  insertText: (text: string) => void;
  replaceMention: (fromAt: number, label: string) => void;
  applyFormat: (command: "bold" | "italic" | "code" | "list") => void;
};

export const ChatRichInput = forwardRef<ChatRichInputHandle, {
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (markdown: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onBlur?: () => void;
}>(function ChatRichInput({
  value,
  placeholder,
  disabled = false,
  onChange,
  onKeyDown,
  onPaste,
  onDragOver,
  onDrop,
  onBlur,
}, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastMarkdown = useRef<string | null>(null);
  const skipEmit = useRef(false);

  const emit = useCallback(() => {
    const root = rootRef.current;
    if (!root || skipEmit.current) return;
    const markdown = htmlToMarkdown(root);
    lastMarkdown.current = markdown;
    onChange(markdown);
  }, [onChange]);

  const paint = useCallback((markdown: string) => {
    const root = rootRef.current;
    if (!root) return;
    skipEmit.current = true;
    root.innerHTML = markdownToHtml(markdown);
    lastMarkdown.current = markdown;
    skipEmit.current = false;
  }, []);

  useEffect(() => {
    if (value === lastMarkdown.current) return;
    paint(value);
  }, [paint, value]);

  useImperativeHandle(ref, () => ({
    focus: () => rootRef.current?.focus(),
    textBeforeCaret: () => {
      const root = rootRef.current;
      return root ? textBeforeCaret(root) : "";
    },
    insertText: (text: string) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      insertTextAtCaret(root, text);
      emit();
    },
    replaceMention: (fromAt: number, label: string) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const before = textBeforeCaret(root);
      const deleteCount = Math.max(1, before.length - fromAt);
      deleteCharsBeforeCaret(root, deleteCount);
      insertTextAtCaret(root, `@${label} `);
      emit();
    },
    applyFormat: (command) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const doc = root.ownerDocument;
      if (command === "bold") doc.execCommand("bold");
      else if (command === "italic") doc.execCommand("italic");
      else if (command === "list") doc.execCommand("insertUnorderedList");
      else if (command === "code") {
        const selection = doc.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
          insertTextAtCaret(root, "`code`");
        } else {
          const wrapped = `\`${selection.toString()}\``;
          range.deleteContents();
          insertTextAtCaret(root, wrapped);
        }
      }
      emit();
    },
  }), [emit]);

  return (
    <div
      ref={rootRef}
      className="chat-composer-input"
      role="textbox"
      contentEditable={!disabled}
      suppressContentEditableWarning
      aria-multiline="true"
      aria-label={placeholder}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      data-empty={value.trim().length === 0 ? "true" : undefined}
      onInput={emit}
      onKeyDown={onKeyDown}
      onPaste={(event) => {
        onPaste?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text) return;
        const root = rootRef.current;
        if (!root) return;
        insertTextAtCaret(root, text);
        emit();
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onBlur={onBlur}
    />
  );
});
