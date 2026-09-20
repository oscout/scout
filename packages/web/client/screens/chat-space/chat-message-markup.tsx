/**
 * Markdown in a Chat turn.
 *
 * Blocks come from the shared parser (headings, lists, fences, tables, quotes).
 * Inline mentions stay Chat's law: only a mention the record carries is
 * highlighted. Operator MessageMarkup is not used here — it extracts agent
 * identities from the body and paints PathTokens through ScoutProvider.
 */

import type { ReactNode } from "react";

import { parseMessageMarkup, type MessageMarkupBlock } from "../../lib/message-markup.ts";
import type { ChatMessage } from "./chat-api.ts";
import { bodySegments } from "./chat-space-model.ts";

const INLINE_PATTERN =
  /`([^`\n]+)`|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"')\]]+)/gu;

function safeHref(value: string): boolean {
  return /^(?:https?:\/\/|mailto:|#)/iu.test(value);
}

function InlineMarkdown({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      nodes.push(<span key={`t${index}`}>{text.slice(cursor, start)}</span>);
    }
    if (match[1] !== undefined) {
      nodes.push(<code key={`c${index}`} className="chat-md-code">{match[1]}</code>);
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={`b${index}`}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<em key={`e${index}`}>{match[3]}</em>);
    } else if (match[4] !== undefined && match[5] !== undefined && safeHref(match[5])) {
      nodes.push(
        <a key={`l${index}`} className="chat-url" href={match[5]} target="_blank" rel="noreferrer">
          {match[4]}
        </a>,
      );
    } else if (match[6] !== undefined && safeHref(match[6])) {
      const href = match[6].replace(/[.,;:!?)]+$/u, "");
      const trailing = match[6].slice(href.length);
      nodes.push(
        <a key={`u${index}`} className="chat-url" href={href} target="_blank" rel="noreferrer">
          {href}
        </a>,
      );
      if (trailing) nodes.push(<span key={`p${index}`}>{trailing}</span>);
    } else {
      nodes.push(<span key={`r${index}`}>{match[0]}</span>);
    }
    cursor = start + match[0].length;
    index += 1;
  }
  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  return <>{nodes.length > 0 ? nodes : text}</>;
}

function Inline({
  text,
  message,
  fallbackLabels,
}: {
  text: string;
  message: ChatMessage;
  fallbackLabels: string[];
}) {
  const segments = bodySegments({ ...message, body: text }, fallbackLabels);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "mention"
          ? <span className="chat-mention" key={index}>{segment.text}</span>
          : <span key={index}><InlineMarkdown text={segment.text} /></span>,
      )}
    </>
  );
}

function Block({
  block,
  message,
  fallbackLabels,
}: {
  block: MessageMarkupBlock;
  message: ChatMessage;
  fallbackLabels: string[];
}) {
  const inline = (text: string) => (
    <Inline text={text} message={message} fallbackLabels={fallbackLabels} />
  );
  switch (block.type) {
    case "paragraph":
      return <p className="chat-md-p">{inline(block.text)}</p>;
    case "heading":
      return (
        <div
          className={`chat-md-h chat-md-h${Math.min(3, block.depth)}`}
          role="heading"
          aria-level={Math.min(4, Math.max(2, block.depth + 1))}
        >
          {inline(block.text)}
        </div>
      );
    case "hr":
      return <hr className="chat-md-hr" />;
    case "list":
      return block.ordered ? (
        <ol className="chat-md-list">
          {block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}
        </ol>
      ) : (
        <ul className="chat-md-list">
          {block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}
        </ul>
      );
    case "blockquote":
      return <blockquote className="chat-md-quote">{inline(block.text)}</blockquote>;
    case "code":
      return (
        <pre className="chat-md-pre" data-lang={block.language ?? undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div className="chat-md-table-wrap">
          <table className="chat-md-table">
            <thead>
              <tr>
                {block.headers.map((header, headerIndex) => (
                  <th key={headerIndex}>{inline(header)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{inline(row[cellIndex] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function ChatMessageMarkup({
  message,
  fallbackLabels = [],
}: {
  message: ChatMessage;
  fallbackLabels?: string[];
}) {
  const blocks = parseMessageMarkup(message.body);
  if (blocks.length === 0) {
    return message.body;
  }
  return (
    <div className="chat-md">
      {blocks.map((block, index) => (
        <Block
          key={index}
          block={block}
          message={message}
          fallbackLabels={fallbackLabels}
        />
      ))}
    </div>
  );
}
