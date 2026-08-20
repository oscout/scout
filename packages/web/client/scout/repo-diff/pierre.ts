/**
 * Repo Diff (SCO-065) — runtime loader for Pierre Diffs + Shiki.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Pierre Diffs (and the Shiki it pulls) are LARGE and only needed when the
 * operator opens the diff viewer — an infrequent, on-demand surface. So we do
 * NOT bundle Pierre and we do NOT add it as a runtime dependency. Instead we
 * load it at runtime from a PINNED esm.sh version.
 *
 *   - `@pierre/diffs@1.2.7` is a **devDependency only**, used for `import type`
 *     (types are erased at build, never bundled). See ./types and the component
 *     files which `import type { … } from "@pierre/diffs/react"`.
 *   - The runtime code (CodeView, parsePatchFiles, …) is fetched from esm.sh
 *     with a versioned URL.
 *
 * ── The version IS the cache key ───────────────────────────────────────────
 * esm.sh versioned URLs are IMMUTABLE: `https://esm.sh/@pierre/diffs@1.2.7/...`
 * never changes content. The browser/HTTP cache and the service worker cache
 * key off the URL, so once fetched the bytes are never re-fetched until we bump
 * `PIERRE_VERSION`. Bumping the constant is the ONLY way to invalidate. Keep it
 * in lockstep with the `@pierre/diffs` devDependency in package.json so the
 * runtime version and the type-checked version match.
 *
 * ── Loaded once per session ────────────────────────────────────────────────
 * A module-level singleton promise means showing many diffs imports Pierre at
 * most once. Robust to load failure: the rejected promise is cleared so a later
 * open can retry, and callers surface an explicit error state (never a blank).
 */

import type {
  CodeViewProps,
  PatchDiffProps,
  WorkerInitializationRenderOptions,
  WorkerPoolOptions,
} from "@pierre/diffs/react";
import type { ParsedPatch } from "@pierre/diffs";
import type {
  RepoDiffLineContext,
  RepoDiffSelectionContext,
} from "./line-context.ts";

/**
 * Pinned Pierre version. THIS STRING IS THE CACHE KEY — esm.sh versioned URLs
 * are immutable, so the library is fetched once and never re-fetched until this
 * is bumped. Must match the `@pierre/diffs` devDependency in package.json so
 * the runtime bytes and the `import type` surface agree.
 */
export const PIERRE_VERSION = "1.2.7";

const PIERRE_BASE = `https://esm.sh/@pierre/diffs@${PIERRE_VERSION}`;

/** The three esm.sh entry points we load. Exposed for the report / debugging. */
// `?external=react,react-dom` makes Pierre import BARE `react`/`react-dom`, which
// the index.html import map resolves to a single pinned esm.sh React — the same
// instance we use to mount Pierre's isolated root (see mountPierreDiff). Without
// it, esm.sh bundles its own React and CodeView's hooks crash ("Cannot read
// properties of null (reading 'useState')") when rendered beside the host React.
export const PIERRE_URLS = {
  /** Non-React surface: parsePatchFiles, preloadHighlighter, constants. */
  base: `${PIERRE_BASE}?external=react,react-dom`,
  /** React components: CodeView, PatchDiff, WorkerPoolContextProvider. */
  react: `${PIERRE_BASE}/react?external=react,react-dom`,
  /** The render worker, instantiated by the WorkerPool factory. */
  worker: `${PIERRE_BASE}/worker/worker.js`,
} as const;

/**
 * Prebaked language set (SCO-065 §12). Warmed up on first viewer open so the
 * common languages highlight without a per-file round-trip. Themes are warmed
 * separately from `render.preferredTheme`.
 */
export const PREBAKED_DIFF_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "rust",
  "swift",
  "shellscript",
  "yaml",
  "css",
  "html",
] as const;

// ── The runtime surface we actually call ────────────────────────────────────
// Typed against the @pierre/diffs devDependency (erased at build). We keep this
// to the *minimum* surface the viewer uses so a Pierre minor bump is easy to
// re-verify.

type WorkerPoolContextProviderProps = {
  poolOptions: WorkerPoolOptions;
  highlighterOptions: WorkerInitializationRenderOptions;
  children: React.ReactNode;
};

type PreloadHighlighterOptions = {
  themes: string[];
  langs: string[];
};

/** The Pierre React entry (esm.sh `/react`). */
type PierreReactModule = {
  CodeView: <LAnnotation = undefined>(
    props: CodeViewProps<LAnnotation> & { ref?: React.Ref<unknown> },
  ) => React.JSX.Element;
  PatchDiff: <LAnnotation = undefined>(
    props: PatchDiffProps<LAnnotation>,
  ) => React.JSX.Element;
  WorkerPoolContextProvider: (
    props: WorkerPoolContextProviderProps,
  ) => React.JSX.Element;
};

/** The Pierre base entry (esm.sh root). */
type PierreBaseModule = {
  parsePatchFiles: (
    data: string,
    cacheKeyPrefix?: string,
    throwOnError?: boolean,
  ) => ParsedPatch[];
  preloadHighlighter: (options: PreloadHighlighterOptions) => Promise<void>;
};

// Minimal shapes for Pierre's OWN React + react-dom (loaded from the same pinned
// esm.sh copy as Pierre's components, via the import map). Typed loosely because
// react-dom is not a dependency of this package.
type ReactCreateElement = (
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
) => unknown;
type IsolatedReactRoot = { render: (node: unknown) => void; unmount: () => void };
type ReactDOMClientModule = {
  createRoot: (container: Element, options?: unknown) => IsolatedReactRoot;
};

/** Everything the viewer needs from a single resolved load. */
export type PierreRuntime = {
  CodeView: PierreReactModule["CodeView"];
  PatchDiff: PierreReactModule["PatchDiff"];
  WorkerPoolContextProvider: PierreReactModule["WorkerPoolContextProvider"];
  parsePatchFiles: PierreBaseModule["parsePatchFiles"];
  preloadHighlighter: PierreBaseModule["preloadHighlighter"];
  /** Worker factory for `WorkerPoolContextProvider.poolOptions`. */
  workerFactory: () => Worker;
  /** Pierre's own `React.createElement` (same instance Pierre components use). */
  createElement: ReactCreateElement;
  /** Pierre's own `react-dom/client` createRoot, for the isolated render root. */
  createRoot: ReactDOMClientModule["createRoot"];
};

// `/* @vite-ignore */` keeps Vite from trying to resolve/bundle the runtime URL
// at build time — these stay live `import()` calls in the shipped bundle.
function importPierreReact(): Promise<PierreReactModule> {
  return import(/* @vite-ignore */ PIERRE_URLS.react) as Promise<PierreReactModule>;
}

function importPierreBase(): Promise<PierreBaseModule> {
  return import(/* @vite-ignore */ PIERRE_URLS.base) as Promise<PierreBaseModule>;
}

let runtimePromise: Promise<PierreRuntime> | null = null;

/**
 * Load Pierre once per session. Subsequent calls return the same promise. On
 * failure the singleton is cleared so a later viewer open can retry (the caller
 * surfaces an explicit "renderer failed to load" state in the meantime).
 */
export function loadPierre(): Promise<PierreRuntime> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    // Pierre's React + react-dom come from the SAME pinned esm.sh copy (via the
    // import map's bare `react`/`react-dom/client` specifiers), so the isolated
    // root we mount and Pierre's components share one React instance. Computed
    // specifiers + `@vite-ignore` keep Vite from resolving these to the app's
    // bundled React at build time.
    const reactSpec = "react";
    const reactDomClientSpec = "react-dom/client";
    const [react, base, reactRuntime, reactDomClient] = await Promise.all([
      importPierreReact(),
      importPierreBase(),
      import(/* @vite-ignore */ reactSpec) as Promise<{
        createElement: ReactCreateElement;
      }>,
      import(/* @vite-ignore */ reactDomClientSpec) as Promise<ReactDOMClientModule>,
    ]);

    // React components are not always plain functions: `forwardRef`/`memo` wrap
    // a component into an OBJECT carrying a `$$typeof` tag (Pierre's `CodeView`
    // is a `forwardRef`, so `typeof CodeView === "object"`). Accept function OR
    // non-null object for the component exports; only the plain utilities must
    // be functions.
    const isComponent = (value: unknown): boolean =>
      typeof value === "function" || (typeof value === "object" && value !== null);
    if (
      !isComponent(react?.CodeView) ||
      !isComponent(react?.WorkerPoolContextProvider) ||
      typeof base?.parsePatchFiles !== "function" ||
      typeof reactRuntime?.createElement !== "function" ||
      typeof reactDomClient?.createRoot !== "function"
    ) {
      throw new Error(
        `Pierre loaded from ${PIERRE_BASE} but the expected exports are missing.`,
      );
    }

    // The worker script lives on esm.sh (cross-origin). `new Worker(crossOrigin)`
    // is blocked by the same-origin policy, so wrap it in a tiny SAME-ORIGIN
    // blob module worker that `import`s the real worker. Module imports (unlike
    // the Worker constructor) allow cross-origin with CORS, and esm.sh serves
    // `Access-Control-Allow-Origin: *`.
    const workerFactory = () => {
      const shim = `import ${JSON.stringify(PIERRE_URLS.worker)};`;
      const blobUrl = URL.createObjectURL(
        new Blob([shim], { type: "text/javascript" }),
      );
      const worker = new Worker(blobUrl, { type: "module" });
      // The blob is only needed to bootstrap the worker; free it once started.
      URL.revokeObjectURL(blobUrl);
      return worker;
    };

    return {
      CodeView: react.CodeView,
      PatchDiff: react.PatchDiff,
      WorkerPoolContextProvider: react.WorkerPoolContextProvider,
      parsePatchFiles: base.parsePatchFiles,
      preloadHighlighter: base.preloadHighlighter,
      workerFactory,
      createElement: reactRuntime.createElement,
      createRoot: reactDomClient.createRoot,
    };
  })();

  // Clear the singleton on failure so the next open retries instead of being
  // stuck on a permanently-rejected promise.
  runtimePromise.catch(() => {
    runtimePromise = null;
  });

  return runtimePromise;
}

let warmupPromise: Promise<void> | null = null;

/**
 * Warm up the Shiki highlighter for the prebaked languages + the requested
 * theme on first viewer open (SCO-065 §12). Idempotent and best-effort:
 * highlighting still works without it (Pierre lazy-loads on demand), so a
 * warmup failure is swallowed rather than blocking the diff.
 */
export function warmupHighlighter(
  runtime: PierreRuntime,
  theme: string,
): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = runtime
    .preloadHighlighter({
      themes: [theme],
      langs: [...PREBAKED_DIFF_LANGUAGES],
    })
    .catch(() => {
      // Best-effort: allow a later open to retry the warmup.
      warmupPromise = null;
    });
  return warmupPromise;
}

/**
 * Parse Git-compatible patch text into Pierre `ParsedPatch[]`. Thin wrapper over
 * Pierre's `parsePatchFiles` with `throwOnError = true` so a malformed patch can
 * be caught and surfaced as a diagnostic by the caller (which then falls back to
 * raw text). The `cacheKeyPrefix` seeds per-file `cacheKey`s for the worker
 * pool's render cache — pass the layer's content-stable render key.
 */
export function parseLayerPatch(
  runtime: PierreRuntime,
  rawPatch: string,
  cacheKeyPrefix: string,
): ParsedPatch[] {
  return runtime.parsePatchFiles(rawPatch, cacheKeyPrefix, true);
}

// Pierre paints diff lines inside each `<diffs-container>` shadow root. Keep the
// add/delete hue signal in the gutter and leave only a faint line wash so dense
// all-addition/all-deletion files do not drown out syntax highlighting.
const REPO_DIFF_LINE_SIGNAL_CSS = `
[data-line-type="change-addition"]:is(
  :where([data-background]) [data-line],
  :where([data-background]) [data-no-newline]
),
[data-line-type="change-deletion"]:is(
  :where([data-background]) [data-line],
  :where([data-background]) [data-no-newline]
) {
  --mix-light: var(--rd-diff-line-mix-light, 94%);
  --mix-dark: var(--rd-diff-line-mix-dark, 92%);
}

[data-line-type="change-addition"]:is(
  :where([data-background]) [data-gutter-buffer],
  :where([data-background]) [data-column-number]
) {
  --mix-light: var(--rd-diff-gutter-mix-light, 76%);
  --mix-dark: var(--rd-diff-gutter-mix-dark, 72%);
  --diffs-diff-line-mix-target: var(--diffs-bg-addition-number-override, var(--diffs-addition-base));
}

[data-line-type="change-deletion"]:is(
  :where([data-background]) [data-gutter-buffer],
  :where([data-background]) [data-column-number]
) {
  --mix-light: var(--rd-diff-gutter-mix-light, 76%);
  --mix-dark: var(--rd-diff-gutter-mix-dark, 72%);
  --diffs-diff-line-mix-target: var(--diffs-bg-deletion-number-override, var(--diffs-deletion-base));
}

[data-column-number]:is(
  [data-indicators="bars"] [data-line-type="change-addition"],
  [data-indicators="bars"] [data-line-type="change-deletion"]
)::before {
  width: var(--rd-diff-spine-width, 6px);
}

[data-column-number]:is([data-indicators="bars"] [data-line-type="change-addition"])::before {
  background-color: var(--diffs-addition-base);
}

[data-column-number]:is([data-indicators="bars"] [data-line-type="change-deletion"])::before {
  background-color: var(--diffs-deletion-base);
  background-image: none;
}
`;

export type PierreDiffRenderInput = {
  items: unknown[];
  theme: string;
  layout: "unified" | "split";
  lineContexts?: RepoDiffLineContext[];
  onIncludeLineContext?: (line: RepoDiffLineContext) => void;
  onIncludeSelectionContext?: (selection: RepoDiffSelectionContext) => void;
};

export type PierreScrollBehavior = "instant" | "smooth" | "smooth-auto";

export type PierreDiffHandle = {
  render: (input: PierreDiffRenderInput) => void;
  /** Scroll the diff surface to a CodeView item (file) by its id. */
  scrollToItem: (id: string, behavior?: PierreScrollBehavior) => void;
  unmount: () => void;
};

type CodeViewScrollHandle = { scrollTo: (target: unknown) => void } | null;

type DiffItemLike = {
  id?: unknown;
  type?: unknown;
  fileDiff?: {
    name?: unknown;
    prevName?: unknown;
  };
};

type CodeViewLineRangeLike = {
  start?: unknown;
  side?: unknown;
  end?: unknown;
  endSide?: unknown;
};

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function filePathCandidates(item: unknown): string[] {
  const diffItem = item as DiffItemLike;
  const fileDiff = diffItem?.type === "diff" ? diffItem.fileDiff : null;
  return [fileDiff?.name, fileDiff?.prevName].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function lineContextMatchesPoint(
  context: RepoDiffLineContext,
  lineNumber: number,
  side: unknown,
): boolean {
  if (side === "additions") return context.newLine === lineNumber;
  if (side === "deletions") return context.oldLine === lineNumber;
  return context.newLine === lineNumber || context.oldLine === lineNumber;
}

function findPointIndex(
  contexts: RepoDiffLineContext[],
  lineNumber: number,
  side: unknown,
): number {
  return contexts.findIndex((context) =>
    lineContextMatchesPoint(context, lineNumber, side),
  );
}

function findLastPointIndex(
  contexts: RepoDiffLineContext[],
  lineNumber: number,
  side: unknown,
): number {
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    if (lineContextMatchesPoint(contexts[i], lineNumber, side)) return i;
  }
  return -1;
}

function lineContextSelectionText(lines: RepoDiffLineContext[]): string {
  return lines
    .map((line) => {
      const sign = line.side === "add" ? "+" : line.side === "del" ? "-" : " ";
      const lineNumber = line.newLine ?? line.oldLine;
      const label = lineNumber != null ? `${lineNumber}: ` : "";
      return `${sign} ${label}${line.text}`;
    })
    .join("\n");
}

function findLineRangeContexts({
  range,
  item,
  lineContexts,
}: {
  range: CodeViewLineRangeLike | null;
  item: unknown;
  lineContexts: RepoDiffLineContext[];
}): RepoDiffLineContext[] | null {
  if (!range) return null;
  const start = toNumber(range.start);
  const end = toNumber(range.end);
  if (start == null || end == null) return null;

  const candidates = filePathCandidates(item);
  const fileContexts = lineContexts.filter(
    (context) => candidates.length === 0 || candidates.includes(context.filePath),
  );
  const startIndex = findPointIndex(fileContexts, start, range.side);
  const endIndex = findLastPointIndex(
    fileContexts,
    end,
    range.endSide ?? range.side,
  );
  if (startIndex < 0 || endIndex < 0) return null;

  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  const selectedLines = fileContexts.slice(from, to + 1);
  return selectedLines.length > 0 ? selectedLines : null;
}

function selectionContextFromLines(
  selectedLines: RepoDiffLineContext[],
): RepoDiffSelectionContext {
  return {
    layer: selectedLines[0]?.layer ?? null,
    filePath: selectedLines[0]?.filePath ?? null,
    text: lineContextSelectionText(selectedLines),
  };
}

/**
 * Mount Pierre's `WorkerPoolContextProvider` + `CodeView` into `container` using
 * Pierre's OWN React + react-dom — an ISOLATED React root. This is the crux of
 * the dual-React fix: Pierre is a React component library loaded from a CDN, so
 * it carries a different React instance than the host app's bundled React.
 * Rendering `<CodeView>` as a child of the host tree makes its hooks read the
 * host's (wrong) dispatcher → crash. Mounting it in its own root, driven by its
 * own react-dom, keeps Pierre's React entirely self-contained; the host React
 * only owns the `container` element.
 *
 * The worker pool is created once inside this root; subsequent `render()` calls
 * (layer / theme / layout changes) update render options through the pool rather
 * than tearing it down (spec §12). `workerFactory` is stable, so the pool is not
 * recreated across renders.
 */
export function mountPierreDiff(
  runtime: PierreRuntime,
  container: Element,
): PierreDiffHandle {
  const root = runtime.createRoot(container);
  // CodeView is a forwardRef exposing a `CodeViewHandle` with `scrollTo`. A
  // stable ref callback keeps re-renders from churning the ref.
  let codeView: CodeViewScrollHandle = null;
  const setCodeView = (handle: CodeViewScrollHandle) => {
    codeView = handle;
  };
  return {
    render({
      items,
      theme,
      layout,
      lineContexts = [],
      onIncludeLineContext,
      onIncludeSelectionContext,
    }) {
      root.render(
        runtime.createElement(
          runtime.WorkerPoolContextProvider,
          {
            poolOptions: { workerFactory: runtime.workerFactory },
            highlighterOptions: { theme, langs: [...PREBAKED_DIFF_LANGUAGES] },
          },
          runtime.createElement(runtime.CodeView, {
            className: "rd-codeview",
            items,
            options: {
              theme,
              diffStyle: layout,
              diffIndicators: "bars",
              stickyHeaders: true,
              unsafeCSS: REPO_DIFF_LINE_SIGNAL_CSS,
              enableGutterUtility: Boolean(onIncludeLineContext),
              enableLineSelection: Boolean(onIncludeSelectionContext),
              lineHoverHighlight: "number",
              onGutterUtilityClick: (range: unknown, item: unknown) => {
                const selectedLines = findLineRangeContexts({
                  range: range as CodeViewLineRangeLike,
                  item,
                  lineContexts,
                });
                if (!selectedLines) return;
                if (selectedLines.length === 1 && onIncludeLineContext) {
                  onIncludeLineContext(selectedLines[0]);
                  return;
                }
                if (onIncludeSelectionContext) {
                  onIncludeSelectionContext(selectionContextFromLines(selectedLines));
                }
              },
            },
            ref: setCodeView,
          }),
        ),
      );
    },
    scrollToItem(id, behavior = "smooth") {
      codeView?.scrollTo({ type: "item", id, align: "start", behavior });
    },
    unmount() {
      root.unmount();
    },
  };
}
