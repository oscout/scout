import { useEffect, useMemo, useRef, useState } from "react";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

/* Scout code palette — restrained, but with enough registers that Swift
   attributes, types, calls, and members read as distinct layers. The dark and
   light sets are tuned pairs; dual-theme CSS picks per [data-scout-theme-mode]. */
const scoutDark = {
  name: "scout-dark",
  type: "dark" as const,
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#ccd3dd",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#707a8c", fontStyle: "italic" } },
    { scope: ["keyword", "keyword.control", "storage.type", "storage.modifier", "keyword.operator.new"], settings: { foreground: "#c792ea" } },
    { scope: ["storage.modifier.attribute", "meta.attribute", "entity.other.attribute-name", "support.variable.attribute", "punctuation.definition.annotation", "meta.annotation"], settings: { foreground: "#e8a662" } },
    { scope: ["string", "punctuation.definition.string", "constant.other.symbol", "markup.inline.raw"], settings: { foreground: "#9ece6a" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "variable.other.constant", "support.constant", "keyword.other.unit"], settings: { foreground: "#e0af68" } },
    { scope: ["entity.name.type", "entity.other.inherited-class", "support.type", "support.class", "entity.name.namespace", "meta.type-name"], settings: { foreground: "#63cdd6" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call", "variable.function"], settings: { foreground: "#82aaff" } },
    { scope: ["variable.other.property", "support.type.property-name", "variable.other.object.property", "meta.attribute-selector"], settings: { foreground: "#a8c1e8" } },
    { scope: ["entity.name.tag"], settings: { foreground: "#c792ea" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "#8a94a6" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#eaeef5", fontStyle: "bold" } },
    { scope: ["markup.underline.link", "string.other.link", "constant.other.reference.link"], settings: { foreground: "#82aaff" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["variable.language", "keyword.other.special-method"], settings: { foreground: "#e0af68" } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: "#e88a8a" } },
  ],
};

const scoutLight = {
  name: "scout-light",
  type: "light" as const,
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#2b3240",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8a8f9c", fontStyle: "italic" } },
    { scope: ["keyword", "keyword.control", "storage.type", "storage.modifier", "keyword.operator.new"], settings: { foreground: "#7c3aed" } },
    { scope: ["storage.modifier.attribute", "meta.attribute", "entity.other.attribute-name", "support.variable.attribute", "punctuation.definition.annotation", "meta.annotation"], settings: { foreground: "#c2410c" } },
    { scope: ["string", "punctuation.definition.string", "constant.other.symbol", "markup.inline.raw"], settings: { foreground: "#15803d" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "variable.other.constant", "support.constant", "keyword.other.unit"], settings: { foreground: "#b45309" } },
    { scope: ["entity.name.type", "entity.other.inherited-class", "support.type", "support.class", "entity.name.namespace", "meta.type-name"], settings: { foreground: "#0e7490" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call", "variable.function"], settings: { foreground: "#2563eb" } },
    { scope: ["variable.other.property", "support.type.property-name", "variable.other.object.property", "meta.attribute-selector"], settings: { foreground: "#44506a" } },
    { scope: ["entity.name.tag"], settings: { foreground: "#7c3aed" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "#7d8595" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#1c2230", fontStyle: "bold" } },
    { scope: ["markup.underline.link", "string.other.link", "constant.other.reference.link"], settings: { foreground: "#2563eb" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["variable.language", "keyword.other.special-method"], settings: { foreground: "#b45309" } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: "#b04a4a" } },
  ],
};

/* Each entry code-splits into its own chunk; a grammar downloads only the
   first time a file of that language is opened. */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  swift: () => import("@shikijs/langs/swift"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  xml: () => import("@shikijs/langs/xml"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  dart: () => import("@shikijs/langs/dart"),
  docker: () => import("@shikijs/langs/docker"),
  make: () => import("@shikijs/langs/make"),
  proto: () => import("@shikijs/langs/proto"),
};

const LANG_BY_EXT: Record<string, string> = {
  swift: "swift",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonl: "json",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  entitlements: "xml",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  sql: "sql",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  m: "objective-c",
  mm: "objective-c",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  dart: "dart",
  dockerfile: "docker",
  makefile: "make",
  proto: "proto",
};

function langFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile") return "docker";
  if (name === "makefile") return "make";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return LANG_BY_EXT[ext] ?? null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

function highlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [scoutDark, scoutLight],
    langs: [],
    engine: createOnigurumaEngine(() => import("shiki/wasm")),
  });
  return highlighterPromise;
}

async function highlight(code: string, lang: string): Promise<string> {
  const core = await highlighter();
  if (!loadedLangs.has(lang)) {
    const grammar = await LANG_LOADERS[lang]();
    await core.loadLanguage(grammar as Parameters<HighlighterCore["loadLanguage"]>[0]);
    loadedLangs.add(lang);
  }
  return core.codeToHtml(code, {
    lang,
    themes: { dark: "scout-dark", light: "scout-light" },
    defaultColor: false,
  });
}

/** Read-only code pane: renders plain text immediately, upgrades in place
    once the TextMate tokens are ready — no blank flash on big files. */
export function ShikiPane({
  code,
  path,
  focusLine,
  endLine,
}: {
  code: string;
  path: string;
  focusLine?: number;
  endLine?: number;
}) {
  const lang = useMemo(() => langFor(path), [path]);
  const [html, setHtml] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHtml(null);
    if (!lang || !LANG_LOADERS[lang]) return;
    let cancelled = false;
    highlight(code, lang)
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        // Grammar failed to load — the plain rendering stays.
      });
    return () => {
      cancelled = true;
    };
  }, [code, path, lang]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const lines = Array.from(container.querySelectorAll<HTMLElement>(".line"));
    for (const line of lines) {
      delete line.dataset.focusLine;
      delete line.dataset.focusStart;
    }
    if (!focusLine || lines.length === 0) return;
    const start = Math.min(Math.max(1, focusLine), lines.length);
    const end = Math.min(Math.max(start, endLine ?? start), lines.length);
    for (let index = start; index <= end; index += 1) {
      lines[index - 1]!.dataset.focusLine = "true";
    }
    const target = lines[start - 1];
    target.dataset.focusStart = "true";
    target.scrollIntoView({ block: "center", inline: "nearest" });
  }, [code, endLine, focusLine, html]);

  if (html) {
    // Shiki output is fully escaped; file contents never reach the DOM raw.
    return <div ref={containerRef} className="s-code-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  const lines = code.split("\n");
  return (
    <div ref={containerRef} className="s-code-shiki">
      <pre className="shiki">
        <code>
          {lines.map((line, index) => (
            // eslint-disable-next-line react/no-array-index-key -- lines are positional
            <span className="line" key={index}>
              {line}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
