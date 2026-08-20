import { useMemo, type ReactNode } from "react";

export type TextDocumentKind = "text" | "markdown" | "code" | "raw";
export type TextDocumentMode = "read" | "preview";
export type TextDocumentLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "markdown"
  | "plain"
  | "shell"
  | "typescript";

export type TextDocument = {
  id: string;
  title: string;
  uri?: string;
  mediaType?: string;
  language?: TextDocumentLanguage;
  kind: TextDocumentKind;
  value: string;
  readOnly?: boolean;
};

export type TextDocumentDetectionInput = {
  id?: string;
  title?: string;
  uri?: string;
  filename?: string;
  mediaType?: string;
  kind?: TextDocumentKind;
  language?: TextDocumentLanguage;
  value: string;
  readOnly?: boolean;
};

const EXTENSION_LANGUAGE: Record<string, TextDocumentLanguage> = {
  cjs: "javascript",
  css: "css",
  htm: "html",
  html: "html",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  mjs: "javascript",
  md: "markdown",
  mdx: "markdown",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  txt: "plain",
};

const CODE_EXTENSIONS = new Set([
  "cjs",
  "css",
  "htm",
  "html",
  "js",
  "jsx",
  "json",
  "mjs",
  "sh",
  "ts",
  "tsx",
]);

function extensionFor(input: Pick<TextDocumentDetectionInput, "filename" | "title" | "uri">): string {
  const name = input.filename ?? input.title ?? input.uri ?? "";
  const clean = name.split(/[?#]/)[0];
  const basename = clean.split("/").pop() ?? clean;
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex >= 0 ? basename.slice(dotIndex + 1).toLowerCase() : "";
}

export function inferTextDocumentLanguage(
  input: Pick<TextDocumentDetectionInput, "filename" | "title" | "uri" | "mediaType">,
): TextDocumentLanguage {
  const mediaType = input.mediaType?.toLowerCase() ?? "";
  if (mediaType.includes("json")) return "json";
  if (mediaType.includes("markdown")) return "markdown";
  if (mediaType.includes("javascript")) return "javascript";
  if (mediaType.includes("typescript")) return "typescript";
  if (mediaType.includes("html")) return "html";
  if (mediaType.includes("css")) return "css";
  if (mediaType.includes("shell") || mediaType.includes("x-sh")) return "shell";

  return EXTENSION_LANGUAGE[extensionFor(input)] ?? "plain";
}

export function detectTextDocumentKind(input: TextDocumentDetectionInput): TextDocumentKind {
  const mediaType = input.mediaType?.toLowerCase() ?? "";
  const extension = extensionFor(input);

  if (mediaType.includes("markdown") || extension === "md" || extension === "mdx") return "markdown";
  if (mediaType.includes("json") || mediaType.includes("javascript") || mediaType.includes("typescript")) return "code";
  if (mediaType.includes("html") || mediaType.includes("xml") || mediaType.includes("css")) return "code";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (mediaType.startsWith("text/") || extension === "txt") return "text";

  const value = input.value.trim();
  if (/^#{1,6}\s+/m.test(value) || /```[\s\S]*```/.test(value)) return "markdown";
  return "text";
}

export function createTextDocument(input: TextDocumentDetectionInput): TextDocument {
  const title = input.title ?? input.filename ?? input.uri?.split("/").pop() ?? "Untitled";
  const language = input.language ?? inferTextDocumentLanguage(input);
  return {
    id: input.id ?? input.uri ?? title,
    title,
    uri: input.uri,
    mediaType: input.mediaType,
    language,
    kind: input.kind ?? detectTextDocumentKind(input),
    value: input.value,
    readOnly: input.readOnly,
  };
}

export function TextDocumentSurface({
  document,
  mode,
  className,
}: {
  document: TextDocument;
  mode?: TextDocumentMode;
  showHeader?: boolean;
  className?: string;
}) {
  const resolvedMode = mode ?? (document.kind === "markdown" ? "preview" : "read");
  const body = document.kind === "markdown" && resolvedMode === "preview"
    ? <MarkdownPreview markdown={document.value} />
    : <CodeLikePreview document={document} />;

  return (
    <div className={`s-text-document-surface s-text-document-surface-${document.kind}${className ? ` ${className}` : ""}`}>
      {body}
    </div>
  );
}

function CodeLikePreview({ document }: { document: TextDocument }) {
  const highlighted = useMemo(
    () => renderHighlightedCode(document.value, document.language ?? document.kind),
    [document.language, document.kind, document.value],
  );

  return (
    <pre className="s-text-document-code" data-language={document.language ?? document.kind}>
      <code>{highlighted}</code>
    </pre>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const blocks = parseMarkdownBlocks(markdown);
  return (
    <div className="s-text-document-markdown">
      {blocks.length > 0 ? blocks : <p />}
    </div>
  );
}

type MarkdownBlock =
  | { kind: "blockquote"; content: string }
  | { kind: "code"; content: string; language?: string }
  | { kind: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; content: string }
  | { kind: "hr" }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; content: string }
  | {
      kind: "table";
      alignments: MarkdownTableAlignment[];
      headers: string[];
      rows: string[][];
    };

type MarkdownTableAlignment = "left" | "center" | "right" | null;

function parseMarkdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      blocks.push({ kind: "code", content: code.join("\n"), language: fence[1] || undefined });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        depth: toHeadingDepth(heading[1].length),
        content: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", content: quote.join(" ") });
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(lines[i] ?? "");
        if (!itemMatch || /\d/.test(itemMatch[2]) !== ordered) {
          break;
        }
        items.push(itemMatch[3]);
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const table = parseMarkdownTableAt(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const nextLine = lines[i] ?? "";
      if (
        !nextLine.trim()
        || /^```/.test(nextLine)
        || /^(#{1,6})\s+/.test(nextLine)
        || /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(nextLine)
        || /^>\s?/.test(nextLine)
        || /^(\s*)([-*+]|\d+[.)])\s+/.test(nextLine)
        || parseMarkdownTableAt(lines, i)
      ) {
        break;
      }
      paragraph.push(nextLine.trim());
      i += 1;
    }
    blocks.push({ kind: "paragraph", content: paragraph.join(" ") });
  }

  return blocks.map((block, index) => renderMarkdownBlock(block, index));
}

function toHeadingDepth(value: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (value <= 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  return 6;
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const HeadingTag = `h${block.depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <HeadingTag key={index}>{renderInlineMarkdown(block.content)}</HeadingTag>;
    }
    case "paragraph":
      return <p key={index}>{renderInlineMarkdown(block.content)}</p>;
    case "blockquote":
      return <blockquote key={index}>{renderInlineMarkdown(block.content)}</blockquote>;
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={`${index}:${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ListTag>
      );
    }
    case "code":
      const language = normalizeCodeLanguage(block.language);
      return (
        <pre key={index} className="s-text-document-fenced-code" data-language={language}>
          <code>{renderHighlightedCode(block.content, language)}</code>
        </pre>
      );
    case "hr":
      return <hr key={index} />;
    case "table":
      return (
        <div key={index} className="s-text-document-table-wrap">
          <table className="s-text-document-table">
            <thead>
              <tr>
                {block.headers.map((header, cellIndex) => (
                  <th
                    key={`${index}:h:${cellIndex}`}
                    data-align={block.alignments[cellIndex] ?? undefined}
                  >
                    {renderInlineMarkdown(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${index}:r:${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${index}:r:${rowIndex}:${cellIndex}`}
                      data-align={block.alignments[cellIndex] ?? undefined}
                    >
                      {renderInlineMarkdown(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function parseMarkdownTableAt(
  lines: string[],
  index: number,
): { block: Extract<MarkdownBlock, { kind: "table" }>; nextIndex: number } | null {
  const header = splitMarkdownTableRow(lines[index] ?? "");
  const alignments = parseMarkdownTableDivider(lines[index + 1] ?? "");
  if (!header || !alignments || header.length !== alignments.length) {
    return null;
  }

  const width = header.length;
  const rows: string[][] = [];
  let cursor = index + 2;
  while (cursor < lines.length) {
    const row = splitMarkdownTableRow(lines[cursor] ?? "");
    if (!row || row.length < 2) {
      break;
    }
    rows.push(normalizeMarkdownTableRow(row, width));
    cursor += 1;
  }

  return {
    block: {
      kind: "table",
      alignments,
      headers: normalizeMarkdownTableRow(header, width),
      rows,
    },
    nextIndex: cursor,
  };
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  let body = trimmed;
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (body.endsWith("|") && !body.endsWith("\\|")) {
    body = body.slice(0, -1);
  }

  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());

  return cells.length >= 2 ? cells : null;
}

function parseMarkdownTableDivider(line: string): MarkdownTableAlignment[] | null {
  const cells = splitMarkdownTableRow(line);
  if (!cells || cells.length < 2) {
    return null;
  }

  const alignments: MarkdownTableAlignment[] = [];
  for (const cell of cells) {
    const marker = cell.replace(/\s/g, "");
    if (!/^:?-{3,}:?$/u.test(marker)) {
      return null;
    }
    if (marker.startsWith(":") && marker.endsWith(":")) {
      alignments.push("center");
    } else if (marker.endsWith(":")) {
      alignments.push("right");
    } else if (marker.startsWith(":")) {
      alignments.push("left");
    } else {
      alignments.push(null);
    }
  }
  return alignments;
}

function normalizeMarkdownTableRow(row: string[], width: number): string[] {
  const normalized = row.slice(0, width);
  while (normalized.length < width) {
    normalized.push("");
  }
  return normalized;
}

type HighlightLanguage = TextDocumentLanguage | TextDocumentKind | string | undefined;
type SyntaxClass =
  | "attribute"
  | "comment"
  | "function"
  | "keyword"
  | "literal"
  | "meta"
  | "number"
  | "operator"
  | "property"
  | "punctuation"
  | "string"
  | "tag"
  | "type";

const TYPE_SCRIPT_PATTERN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?n?\b|\b[A-Za-z_$][\w$]*\b|=>|[{}()[\].,;:?]|[-+*/%=&|!<>~^]+/giu;
const JSON_PATTERN = /"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false|null)\b|[{}\[\]:,]/giu;
const CSS_PATTERN = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[0-9a-f]{3,8}\b|@[a-z-]+|--[a-z0-9-]+|[a-z-]+(?=\s*:)|\b\d+(?:\.\d+)?(?:%|px|r?em|vh|vw|vmin|vmax|s|ms|deg|fr)?\b|[{}():;,]|\.[a-z_][\w-]*|#[a-z_][\w-]*|[a-z_][\w-]*/giu;
const HTML_PATTERN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-z][\w:-]*|\/?>|[a-z_:][\w:.-]*(?==)|=|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|&[a-z0-9#]+;/giu;
const SHELL_PATTERN = /#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'|\$\{?[\w?@#$!-]+\}?|--?[A-Za-z0-9][\w-]*(?:=[^\s]+)?|\b(?:case|cd|do|done|echo|elif|else|esac|exit|export|fi|for|function|if|in|local|return|set|source|test|then|unset|while)\b|\b\d+\b|[|&;(){}<>]/giu;

const TS_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "interface",
  "is",
  "keyof",
  "let",
  "new",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "switch",
  "throw",
  "try",
  "type",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const TS_LITERALS = new Set(["false", "null", "super", "this", "true", "undefined"]);

function renderHighlightedCode(value: string, language: HighlightLanguage): ReactNode[] {
  const normalized = normalizeCodeLanguage(language);
  switch (normalized) {
    case "css":
      return tokenizeSyntax(value, CSS_PATTERN, classifyCssToken);
    case "html":
      return tokenizeSyntax(value, HTML_PATTERN, classifyHtmlToken);
    case "javascript":
    case "typescript":
      return tokenizeSyntax(value, TYPE_SCRIPT_PATTERN, classifyTypeScriptToken);
    case "json":
      return tokenizeSyntax(value, JSON_PATTERN, classifyJsonToken);
    case "shell":
      return tokenizeSyntax(value, SHELL_PATTERN, classifyShellToken);
    default:
      return [value];
  }
}

function tokenizeSyntax(
  value: string,
  pattern: RegExp,
  classify: (token: string, start: number, end: number, source: string) => SyntaxClass | null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const token = match[0];
    if (!token) {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) {
      nodes.push(value.slice(cursor, match.index));
    }
    const className = classify(token, match.index, match.index + token.length, value);
    nodes.push(className
      ? (
          <span key={`syntax-${tokenIndex++}`} className={`s-syntax s-syntax-${className}`}>
            {token}
          </span>
        )
      : token);
    cursor = match.index + token.length;
  }

  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }

  return nodes.length > 0 ? nodes : [value];
}

function normalizeCodeLanguage(language: HighlightLanguage): TextDocumentLanguage {
  const value = String(language ?? "").toLowerCase().replace(/^\./, "");
  if (value === "bash" || value === "sh" || value === "shell" || value === "zsh") return "shell";
  if (value === "css" || value === "scss") return "css";
  if (value === "html" || value === "htm" || value === "xml" || value === "svg") return "html";
  if (value === "js" || value === "jsx" || value === "javascript" || value === "mjs" || value === "cjs") return "javascript";
  if (value === "json" || value === "jsonc") return "json";
  if (value === "markdown" || value === "md" || value === "mdx") return "markdown";
  if (value === "ts" || value === "tsx" || value === "typescript") return "typescript";
  return "plain";
}

function classifyTypeScriptToken(token: string, start: number, end: number, source: string): SyntaxClass | null {
  if (token.startsWith("//") || token.startsWith("/*")) return "comment";
  if (startsWithQuote(token)) return "string";
  if (/^\d/u.test(token)) return "number";
  if (TS_KEYWORDS.has(token)) return "keyword";
  if (TS_LITERALS.has(token)) return "literal";
  if (/^[A-Z][\w$]*$/u.test(token)) return "type";
  if (/^[A-Za-z_$][\w$]*$/u.test(token) && source.slice(end).trimStart().startsWith("(")) return "function";
  if (/^[{}()[\].,;:?]$/u.test(token)) return "punctuation";
  if (/^(?:=>|[-+*/%=&|!<>~^]+)$/u.test(token)) return "operator";
  return null;
}

function classifyJsonToken(token: string, _start: number, end: number, source: string): SyntaxClass | null {
  if (startsWithQuote(token)) return source.slice(end).trimStart().startsWith(":") ? "property" : "string";
  if (/^-?\d/u.test(token)) return "number";
  if (token === "true" || token === "false" || token === "null") return "literal";
  return "punctuation";
}

function classifyCssToken(token: string, _start: number, end: number, source: string): SyntaxClass | null {
  if (token.startsWith("/*")) return "comment";
  if (startsWithQuote(token)) return "string";
  if (token.startsWith("@")) return "keyword";
  if (token.startsWith("#") && /^#[0-9a-f]/iu.test(token)) return "number";
  if (/^\d/u.test(token)) return "number";
  if (token.startsWith(".") || token.startsWith("#")) return "tag";
  if (/^--/u.test(token) || source.slice(end).trimStart().startsWith(":")) return "property";
  if (/^[{}():;,]$/u.test(token)) return "punctuation";
  return null;
}

function classifyHtmlToken(token: string): SyntaxClass | null {
  if (token.startsWith("<!--")) return "comment";
  if (/^<!doctype/iu.test(token) || token.startsWith("&")) return "meta";
  if (token.startsWith("<")) return "tag";
  if (startsWithQuote(token)) return "string";
  if (token === "=") return "operator";
  if (token === ">" || token === "/>") return "punctuation";
  return "attribute";
}

function classifyShellToken(token: string): SyntaxClass | null {
  if (token.startsWith("#")) return "comment";
  if (startsWithQuote(token)) return "string";
  if (token.startsWith("$")) return "property";
  if (token.startsWith("-")) return "attribute";
  if (/^\d/u.test(token)) return "number";
  if (/^[|&;(){}<>]$/u.test(token)) return "operator";
  if (SHELL_PATTERN_KEYWORDS.has(token)) return "keyword";
  return null;
}

const SHELL_PATTERN_KEYWORDS = new Set([
  "case",
  "cd",
  "do",
  "done",
  "echo",
  "elif",
  "else",
  "esac",
  "exit",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "return",
  "set",
  "source",
  "test",
  "then",
  "unset",
  "while",
]);

function startsWithQuote(value: string): boolean {
  return value.startsWith("\"") || value.startsWith("'") || value.startsWith("`");
}

// Inline grammar — sticky (`y`) so each rule only matches at the cursor. Tried
// in precedence order: code (literal) → link → ***bi*** → **b** / __b__ →
// ~~strike~~ → *i* / _i_. Emphasis content is rendered recursively so nesting
// (a bold span containing a link or italic) renders correctly. `__`/`_` only
// open at a word boundary, so snake_case / file_paths stay literal.
const INLINE_CODE = /`([^`]+)`/y;
const INLINE_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/y;
const INLINE_BOLD_ITALIC = /\*\*\*(.+?)\*\*\*/y;
const INLINE_BOLD = /\*\*(.+?)\*\*/y;
const INLINE_BOLD_ALT = /__(.+?)__(?!\w)/y;
const INLINE_STRIKE = /~~(.+?)~~/y;
const INLINE_ITALIC = /\*(?!\s)([^*]+?)\*/y;
const INLINE_ITALIC_ALT = /_(?!\s)([^_]+?)_(?!\w)/y;

function matchInlineAt(pattern: RegExp, value: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  const match = pattern.exec(value);
  return match && match.index === index ? match : null;
}

function renderInlineMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let text = "";
  let i = 0;
  let key = 0;

  const flush = () => {
    if (text) {
      nodes.push(text);
      text = "";
    }
  };

  while (i < value.length) {
    const atBoundary = i === 0 || /[^\w]/.test(value[i - 1] ?? "");

    const code = matchInlineAt(INLINE_CODE, value, i);
    if (code) {
      flush();
      nodes.push(<code key={key++}>{code[1]}</code>);
      i += code[0].length;
      continue;
    }

    const link = matchInlineAt(INLINE_LINK, value, i);
    if (link) {
      flush();
      const href = safeMarkdownHref(link[2]);
      nodes.push(href
        ? (
            <a key={key++} href={href} target="_blank" rel="noreferrer">
              {renderInlineMarkdown(link[1])}
            </a>
          )
        : <span key={key++}>{renderInlineMarkdown(link[1])}</span>);
      i += link[0].length;
      continue;
    }

    const boldItalic = matchInlineAt(INLINE_BOLD_ITALIC, value, i);
    if (boldItalic) {
      flush();
      nodes.push(
        <strong key={key++}>
          <em>{renderInlineMarkdown(boldItalic[1])}</em>
        </strong>,
      );
      i += boldItalic[0].length;
      continue;
    }

    const bold = matchInlineAt(INLINE_BOLD, value, i) ?? (atBoundary ? matchInlineAt(INLINE_BOLD_ALT, value, i) : null);
    if (bold) {
      flush();
      nodes.push(<strong key={key++}>{renderInlineMarkdown(bold[1])}</strong>);
      i += bold[0].length;
      continue;
    }

    const strike = matchInlineAt(INLINE_STRIKE, value, i);
    if (strike) {
      flush();
      nodes.push(<del key={key++}>{renderInlineMarkdown(strike[1])}</del>);
      i += strike[0].length;
      continue;
    }

    const italic = matchInlineAt(INLINE_ITALIC, value, i) ?? (atBoundary ? matchInlineAt(INLINE_ITALIC_ALT, value, i) : null);
    if (italic) {
      flush();
      nodes.push(<em key={key++}>{renderInlineMarkdown(italic[1])}</em>);
      i += italic[0].length;
      continue;
    }

    text += value[i];
    i += 1;
  }

  flush();
  return nodes;
}

function safeMarkdownHref(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? value
      : null;
  } catch {
    return null;
  }
}
