import type { ReactNode } from "react";

import { parseMessageMarkup, type MessageMarkupBlock } from "./message-markup.ts";
import { renderWithMentions } from "./mentions.tsx";

function renderHeading(block: Extract<MessageMarkupBlock, { type: "heading" }>, key: number): ReactNode {
  const level = Math.min(6, Math.max(2, block.depth + 1));
  return (
    <div
      key={key}
      role="heading"
      aria-level={level}
      className={`s-message-markup-heading s-message-markup-heading-${block.depth}`}
    >
      {renderWithMentions(block.text)}
    </div>
  );
}

function renderTable(block: Extract<MessageMarkupBlock, { type: "table" }>, key: number): ReactNode {
  return (
    <div key={key} className="s-message-markup-table-wrap">
      <table className="s-message-markup-table">
        <thead>
          <tr>
            {block.headers.map((header, index) => (
              <th key={`${key}:h:${index}`}>{renderWithMentions(header)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${key}:r:${rowIndex}`}>
              {block.headers.map((_, cellIndex) => (
                <td key={`${key}:c:${rowIndex}:${cellIndex}`}>
                  {renderWithMentions(row[cellIndex] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlock(block: MessageMarkupBlock, key: number): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="s-message-markup-paragraph">
          {renderWithMentions(block.text)}
        </p>
      );
    case "heading":
      return renderHeading(block, key);
    case "hr":
      return <hr key={key} className="s-message-markup-rule" />;
    case "list":
      return block.ordered ? (
        <ol key={key} className="s-message-markup-list">
          {block.items.map((item, index) => (
            <li key={`${key}:${index}`}>{renderWithMentions(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="s-message-markup-list">
          {block.items.map((item, index) => (
            <li key={`${key}:${index}`}>{renderWithMentions(item)}</li>
          ))}
        </ul>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="s-message-markup-quote">
          {renderWithMentions(block.text)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={key} className="s-message-markup-code">
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return renderTable(block, key);
  }
}

export function MessageMarkup({
  text,
  className,
}: {
  text: string | null | undefined;
  className?: string;
}) {
  const blocks = parseMessageMarkup(text ?? "");
  if (blocks.length === 0) {
    return text ?? "";
  }

  return (
    <div className={["s-message-markup", className].filter(Boolean).join(" ")}>
      {blocks.map(renderBlock)}
    </div>
  );
}
