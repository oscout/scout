/**
 * Chat composer rich text.
 *
 * The wire is still markdown (`message.body`). The composer paints a small
 * HTML subset so typing **bold** is not a lie. Conversion is lossy on purpose:
 * only the marks ChatMessageMarkup can render survive a round trip.
 */

import { parseMessageMarkup } from "../../lib/message-markup.ts";

const INLINE_PATTERN =
  /`([^`\n]+)`|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function unescapeText(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"");
}

function inlineToHtml(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) pieces.push(escapeHtml(text.slice(cursor, start)));
    if (match[1] !== undefined) {
      pieces.push(`<code class="chat-md-code">${escapeHtml(match[1])}</code>`);
    } else if (match[2] !== undefined) {
      pieces.push(`<strong>${escapeHtml(match[2])}</strong>`);
    } else if (match[3] !== undefined) {
      pieces.push(`<em>${escapeHtml(match[3])}</em>`);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      pieces.push(
        `<a class="chat-url" href="${escapeHtml(match[5])}">${escapeHtml(match[4])}</a>`,
      );
    } else {
      pieces.push(escapeHtml(match[0] ?? ""));
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) pieces.push(escapeHtml(text.slice(cursor)));
  return pieces.join("");
}

export function markdownToHtml(markdown: string): string {
  const blocks = parseMessageMarkup(markdown);
  if (blocks.length === 0) {
    return markdown.trim() ? `<p>${inlineToHtml(markdown)}</p>` : "";
  }
  return blocks.map((block) => {
    switch (block.type) {
      case "paragraph":
        return `<p>${inlineToHtml(block.text)}</p>`;
      case "heading": {
        const level = Math.min(3, Math.max(1, block.depth));
        return `<div class="chat-md-h chat-md-h${level}" role="heading" aria-level="${level + 1}">${inlineToHtml(block.text)}</div>`;
      }
      case "hr":
        return `<hr class="chat-md-hr">`;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items.map((item) => `<li>${inlineToHtml(item)}</li>`).join("");
        return `<${tag} class="chat-md-list">${items}</${tag}>`;
      }
      case "blockquote":
        return `<blockquote class="chat-md-quote">${inlineToHtml(block.text)}</blockquote>`;
      case "code":
        return `<pre class="chat-md-pre"><code>${escapeHtml(block.text)}</code></pre>`;
      case "table": {
        const head = block.headers.map((cell) => `<th>${inlineToHtml(cell)}</th>`).join("");
        const rows = block.rows.map((row) =>
          `<tr>${block.headers.map((_, index) => `<td>${inlineToHtml(row[index] ?? "")}</td>`).join("")}</tr>`
        ).join("");
        return `<table class="chat-md-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
      }
    }
  }).join("");
}

function wrap(mark: string, inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return inner;
  if (inner.startsWith(mark) && inner.endsWith(mark)) return inner;
  return `${mark}${inner}${mark}`;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return unescapeText(node.textContent ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "BR") return "\n";
  if (tag === "PRE") {
    const text = (el.textContent ?? "").replace(/\n$/u, "");
    return `\n\`\`\`\n${text}\n\`\`\`\n`;
  }
  const inner = Array.from(el.childNodes).map(serializeNode).join("");
  switch (tag) {
    case "STRONG":
    case "B":
      return wrap("**", inner);
    case "EM":
    case "I":
      return wrap("*", inner);
    case "CODE":
      return el.closest("pre") ? inner : (inner ? `\`${inner}\`` : "");
    case "A": {
      const href = el.getAttribute("href") ?? "";
      if (!href || href === inner) return inner;
      return `[${inner}](${href})`;
    }
    case "H1":
      return `\n# ${inner.trim()}\n`;
    case "H2":
      return `\n## ${inner.trim()}\n`;
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `\n### ${inner.trim()}\n`;
    case "BLOCKQUOTE":
      return `\n${inner.split("\n").map((line) => `> ${line}`).join("\n")}\n`;
    case "LI": {
      const parent = el.parentElement?.tagName;
      const mark = parent === "OL" ? "1. " : "- ";
      return `${mark}${inner.trim()}\n`;
    }
    case "UL":
    case "OL":
      return `\n${inner}`;
    case "P":
    case "DIV": {
      if (el.getAttribute("role") === "heading") {
        const level = Number(el.getAttribute("aria-level") ?? "3");
        const marks = level <= 2 ? "#" : level === 3 ? "##" : "###";
        return `\n${marks} ${inner.trim()}\n`;
      }
      return inner ? `${inner}\n\n` : "\n";
    }
    case "HR":
      return "\n---\n";
    case "TR":
      return `| ${Array.from(el.children).map((cell) => serializeNode(cell).trim()).join(" | ")} |\n`;
    case "TABLE":
      return `\n${inner}\n`;
    case "THEAD":
    case "TBODY":
    case "TH":
    case "TD":
    case "SPAN":
      return inner;
    default:
      return inner;
  }
}

export function htmlToMarkdown(root: HTMLElement): string {
  const raw = Array.from(root.childNodes).map(serializeNode).join("");
  return raw.replace(/\u00a0/gu, " ").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function textBeforeCaret(root: HTMLElement): string {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
    return root.innerText ?? "";
  }
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(root);
  range.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
  return range.toString();
}

export function deleteCharsBeforeCaret(root: HTMLElement, count: number): void {
  if (count <= 0) return;
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  selection.modify("extend", "backward", "character");
  for (let i = 1; i < count; i += 1) {
    selection.modify("extend", "backward", "character");
  }
  selection.deleteFromDocument();
}

export function insertTextAtCaret(root: HTMLElement, text: string): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection) {
    root.append(text);
    return;
  }
  if (selection.rangeCount === 0) {
    root.focus();
  }
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : root.ownerDocument.createRange();
  if (selection.rangeCount === 0) {
    range.selectNodeContents(root);
    range.collapse(false);
    selection.addRange(range);
  }
  range.deleteContents();
  const node = root.ownerDocument.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
