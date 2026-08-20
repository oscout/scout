import { ExternalLink } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useScout } from "../scout/Provider.tsx";
import { api } from "./api.ts";

export type InlineToken =
  | { kind: "text"; body: string }
  | { kind: "code"; body: string }
  | { kind: "bold"; body: string }
  | { kind: "italic"; body: string }
  | { kind: "file-path"; body: string };

const FILE_PATH_PATTERN =
  /(?:^|(?<=[\s(`'"<>]))(?:~\/|\/(?:Users|home|opt|var|etc|tmp|private)\/)[^\s)`'"<>]+\.[A-Za-z0-9]{1,8}\b/g;

export type Block =
  | { kind: "paragraph"; lines: InlineToken[][] }
  | { kind: "list"; items: InlineToken[][] }
  | { kind: "code"; body: string }
  | { kind: "heading"; level: 1 | 2 | 3; tokens: InlineToken[] };

export function parseScoutbotMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", body: body.join("\n") });
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*\S)\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, tokens: parseInline(headingMatch[2]) });
      i += 1;
      continue;
    }

    if (isBulletLine(line)) {
      const items: InlineToken[][] = [];
      while (i < lines.length && isBulletLine(lines[i])) {
        items.push(parseInline(stripBullet(lines[i])));
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }

    const paragraphLines: InlineToken[][] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !isBulletLine(lines[i]) &&
      !/^#{1,3}\s+\S/.test(lines[i])
    ) {
      paragraphLines.push(parseInline(lines[i]));
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

const BULLET_PATTERN = /^\s*[-*]\s+/;

function isBulletLine(line: string): boolean {
  return BULLET_PATTERN.test(line);
}

function stripBullet(line: string): string {
  return line.replace(BULLET_PATTERN, "");
}

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let buffer = "";

  const flush = () => {
    if (buffer) {
      tokens.push({ kind: "text", body: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    const c = text[i];

    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        tokens.push({ kind: "code", body: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (c === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        tokens.push({ kind: "bold", body: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    } else if (c === "*" || c === "_") {
      const closeIndex = findInlineClose(text, i + 1, c);
      if (closeIndex !== -1) {
        flush();
        tokens.push({ kind: "italic", body: text.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
    }

    buffer += c;
    i += 1;
  }

  flush();
  return expandFilePaths(tokens);
}

function expandFilePaths(tokens: InlineToken[]): InlineToken[] {
  const result: InlineToken[] = [];
  for (const token of tokens) {
    if (token.kind !== "text") {
      result.push(token);
      continue;
    }
    const segments = splitAroundFilePaths(token.body);
    if (segments.length === 1 && segments[0].kind === "text") {
      result.push(token);
    } else {
      result.push(...segments);
    }
  }
  return result;
}

function splitAroundFilePaths(text: string): InlineToken[] {
  if (!text) return [];
  const out: InlineToken[] = [];
  let cursor = 0;
  FILE_PATH_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > cursor) {
      out.push({ kind: "text", body: text.slice(cursor, start) });
    }
    out.push({ kind: "file-path", body: match[0] });
    cursor = end;
  }
  if (cursor === 0) {
    return [{ kind: "text", body: text }];
  }
  if (cursor < text.length) {
    out.push({ kind: "text", body: text.slice(cursor) });
  }
  return out;
}

function findInlineClose(text: string, start: number, marker: string): number {
  if (text[start] === undefined || /\s/.test(text[start])) {
    return -1;
  }
  for (let j = start; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === marker) {
      const prev = text[j - 1];
      if (prev && !/\s/.test(prev) && text[j + 1] !== marker) {
        return j;
      }
    }
    if (ch === "\n") return -1;
  }
  return -1;
}

export function stripScoutbotMarkdown(input: string): string {
  return parseScoutbotMarkdown(input)
    .map(blockToPlainText)
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

function blockToPlainText(block: Block): string {
  switch (block.kind) {
    case "paragraph":
      return block.lines.map((line) => inlineToPlainText(line)).join(" ");
    case "list":
      return block.items.map((item) => inlineToPlainText(item)).join(". ");
    case "code":
      return block.body.trim();
    case "heading":
      return inlineToPlainText(block.tokens);
  }
}

function inlineToPlainText(tokens: InlineToken[]): string {
  return tokens.map((token) => token.body).join("");
}

export function ScoutbotMarkdown({ text }: { text: string }) {
  const blocks = parseScoutbotMarkdown(text);
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-[var(--scout-chrome-ink)]">
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} />
      ))}
    </div>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap break-words">
          {block.lines.map((line, index) => (
            <Fragment key={index}>
              {index > 0 && "\n"}
              <InlineNodes tokens={line} />
            </Fragment>
          ))}
        </p>
      );
    case "list":
      return (
        <ul className="ml-3 flex list-disc flex-col gap-1 marker:text-[var(--scout-chrome-ink-ghost)]">
          {block.items.map((item, index) => (
            <li key={index} className="break-words pl-0.5">
              <InlineNodes tokens={item} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded border border-[var(--scout-chrome-border-soft)] bg-black/25 px-2 py-1.5 text-xs leading-relaxed text-lime-100/90">
          {block.body}
        </pre>
      );
    case "heading": {
      const baseClass = "font-mono text-[var(--scout-chrome-ink-strong)] mt-2 first:mt-0";
      if (block.level === 1) {
        return (
          <h2 className={`${baseClass} text-lg font-bold uppercase tracking-[0.12em]`}>
            <InlineNodes tokens={block.tokens} />
          </h2>
        );
      }
      if (block.level === 2) {
        return (
          <h3 className={`${baseClass} text-sm font-bold uppercase tracking-[0.14em] text-[var(--scout-chrome-ink)]`}>
            <InlineNodes tokens={block.tokens} />
          </h3>
        );
      }
      return (
        <h4 className={`${baseClass} text-xs font-bold uppercase tracking-[0.16em] text-[var(--scout-chrome-ink-faint)]`}>
          <InlineNodes tokens={block.tokens} />
        </h4>
      );
    }
  }
}

function InlineNodes({ tokens }: { tokens: InlineToken[] }): ReactNode {
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.kind) {
          case "text":
            return <Fragment key={index}>{token.body}</Fragment>;
          case "code":
            return (
              <code
                key={index}
                className="rounded bg-black/25 px-1 text-xs text-lime-100/90"
              >
                {token.body}
              </code>
            );
          case "bold":
            return (
              <strong key={index} className="font-bold text-[var(--scout-chrome-ink-strong)]">
                {token.body}
              </strong>
            );
          case "italic":
            return (
              <em key={index} className="italic">
                {token.body}
              </em>
            );
          case "file-path":
            return <FilePathChip key={index} path={token.body} />;
        }
      })}
    </>
  );
}

function FilePathChip({ path }: { path: string }) {
  const { openFilePreview } = useScout();
  const display = shortFilePath(path);
  const revealInOs = (event: React.MouseEvent) => {
    event.stopPropagation();
    void api("/api/file/reveal", {
      method: "POST",
      body: JSON.stringify({ path }),
    }).catch(() => {});
  };
  return (
    <span className="inline-flex items-center gap-1 align-baseline">
      <button
        type="button"
        onClick={() => openFilePreview(path)}
        title={`Preview ${path} in Scout`}
        className="inline-flex items-center gap-1 rounded border border-lime-300/30 bg-lime-300/[0.05] px-1.5 py-[1px] font-mono text-xs text-lime-200 transition-colors hover:bg-lime-300/[0.12] hover:text-lime-100"
      >
        <span className="truncate">{display}</span>
      </button>
      <button
        type="button"
        onClick={revealInOs}
        title={`Open ${path} in your OS`}
        aria-label="Open in OS"
        className="inline-flex items-center justify-center rounded border border-[var(--scout-chrome-border-soft)] p-[2px] text-[var(--scout-chrome-ink-faint)] transition-colors hover:bg-[var(--scout-chrome-hover)] hover:text-[var(--scout-chrome-ink)]"
      >
        <ExternalLink size={10} />
      </button>
    </span>
  );
}

function shortFilePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
