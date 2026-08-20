import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Copy } from "lucide-react";
import { api } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import { forwardScoutbotUiActionToNativeHost } from "../../lib/scoutbot.ts";
import type { Route } from "../../lib/types.ts";
import { fetchRepoWatchSnapshot, getCachedRepoWatchSnapshot } from "../../scout/repo-watch/api.ts";
import type { RepoWatchSnapshot } from "../../scout/repo-watch/types.ts";
import { defineSurface } from "../../surfaces/types.ts";
import { CodeDiffPane } from "./CodeDiffPane.tsx";
import { CodeProjectPicker, type CodePickerSelection } from "./CodeProjectPicker.tsx";
import { formatScoutCodeDeepLink } from "./code-deep-link.ts";
import { relativeFilePath } from "./code-diff-model.ts";
import { shortRootPath } from "./code-project-picker-model.ts";
import { ShikiPane } from "./ShikiPane.tsx";
import { readLastRoot, readStoredTree, writeLastRoot, writeStoredTree } from "./code-tree-store.ts";
import "./code-screen.css";

/* Heavy machine-owned directories that only add noise to a reading tree. */
const IGNORED_DIR_NAMES = new Set(["node_modules", ".git", "dist", ".next", ".build", "DerivedData", "__pycache__", ".venv", "target"]);

type DirEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
};

type FilePreviewResponse =
  | {
      kind: "file";
      previewable: true;
      path: string;
      title: string;
      mediaType: string;
      rawUrl: string;
      content: string;
      sizeBytes: number;
      truncated: boolean;
    }
  | {
      kind: "file";
      previewable: false;
      path: string;
      title: string;
      mediaType: string;
      rawUrl: string;
      sizeBytes: number;
      previewReason: string;
    }
  | {
      kind: "directory";
      path: string;
      entries: DirEntry[];
    };

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/";
}

function pathLeaf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/** Resolve a /code/<project> slug against the snapshot: project + optional worktree. */
function resolveProjectLink(
  snapshot: RepoWatchSnapshot,
  projectSlug: string,
  wt: string | null,
): { projectName: string; root: string } | null {
  const needle = slugify(projectSlug);
  const project = snapshot.projects.find(
    (candidate) => slugify(candidate.name) === needle || slugify(pathLeaf(candidate.root)) === needle,
  );
  if (!project) return null;
  const worktree = wt
    ? project.worktrees.find(
        (candidate) => candidate.name === wt || candidate.branch.name === wt || slugify(candidate.name) === slugify(wt),
      )
    : project.worktrees[0];
  return { projectName: project.name, root: worktree?.path ?? project.root };
}

/** Directory chain between a root and a file inside it (excludes the file). */
function ancestorDirs(rootPath: string, filePath: string): string[] {
  if (!filePath.startsWith(`${rootPath}/`)) return [];
  const rel = filePath.slice(rootPath.length + 1).split("/");
  const dirs: string[] = [];
  let current = rootPath;
  for (const segment of rel.slice(0, -1)) {
    current = `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}

/** Cursor/VS Code idiom: one letter at the row's trailing edge. */
function diffBadge(status: string): string {
  switch (status) {
    case "untracked":
      return "U";
    case "conflicted":
      return "C";
    case "staged":
      return "S";
    case "unstaged":
      return "M";
    case "staged+unstaged":
      return "SM";
    default:
      return status.charAt(0).toUpperCase();
  }
}

type TreeRow = {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
  loading?: boolean;
};

/**
 * A /code/<project>/<path> URL is a request, not a suggestion: while the slug
 * is being resolved the target stays on screen, and a miss must name the slug
 * and why — never the generic "no repo selected" empty state.
 */
type CodeLinkResolution =
  | { phase: "idle" }
  | { phase: "resolving" }
  | { phase: "failed"; message: string };

function collectTreeRows(
  dir: string,
  depth: number,
  childrenByPath: Map<string, DirEntry[]>,
  expanded: ReadonlySet<string>,
  out: TreeRow[],
): void {
  const entries = childrenByPath.get(dir);
  if (!entries) {
    out.push({ path: `${dir}#loading`, name: "Loading…", kind: "file", depth, loading: true });
    return;
  }
  for (const entry of entries) {
    if (entry.kind === "directory" && IGNORED_DIR_NAMES.has(entry.name)) continue;
    out.push({ path: entry.path, name: entry.name, kind: entry.kind, depth });
    if (entry.kind === "directory" && expanded.has(entry.path)) {
      collectTreeRows(entry.path, depth + 1, childrenByPath, expanded, out);
    }
  }
}

export function CodeContent({
  route,
  navigate,
  root: rootProp,
  file: fileProp,
  project: projectProp,
  path: pathProp,
  wt: wtProp,
  line: lineProp,
  endLine: endLineProp,
  returnConversationId: returnConversationIdProp,
  embedded = false,
}: {
  route?: Extract<Route, { view: "code" }>;
  navigate?: (route: Route) => void;
  root?: string;
  file?: string;
  project?: string;
  path?: string;
  wt?: string;
  line?: number;
  endLine?: number;
  returnConversationId?: string;
  embedded?: boolean;
}) {
  const initialRoot = rootProp ?? route?.root ?? null;
  const initialFile = fileProp ?? route?.file ?? null;
  const linkProject = projectProp ?? route?.project ?? null;
  const linkPath = pathProp ?? route?.path ?? null;
  const linkWt = wtProp ?? route?.wt ?? null;
  const initialLine = lineProp ?? route?.line;
  const initialEndLine = endLineProp ?? route?.endLine;
  const returnConversationId = returnConversationIdProp ?? route?.returnConversationId ?? null;

  const [snapshot, setSnapshot] = useState<RepoWatchSnapshot | null>(() => getCachedRepoWatchSnapshot());
  // With no explicit target, reopen where the operator last was — the surface
  // should greet you with your repo, not a picker.
  const [root, setRoot] = useState<string | null>(() => initialRoot ?? (linkProject ? null : readLastRoot()));
  const [childrenByPath, setChildrenByPath] = useState<Map<string, DirEntry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile);
  const [filePreview, setFilePreview] = useState<FilePreviewResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [fileMode, setFileMode] = useState<"source" | "changes">("source");
  const [focusedLines, setFocusedLines] = useState<{ line: number; endLine?: number } | null>(() => (
    initialLine && initialLine > 0
      ? { line: initialLine, ...(initialEndLine && initialEndLine >= initialLine ? { endLine: initialEndLine } : {}) }
      : null
  ));
  const [linkResolution, setLinkResolution] = useState<CodeLinkResolution>(() => (
    linkProject ? { phase: "resolving" } : { phase: "idle" }
  ));
  // Each distinct link target applies once: later snapshot arrivals must not
  // yank the root away, but a newly navigated-to link must still resolve.
  const linkKey = linkProject ? `${linkProject}\0${linkPath ?? ""}\0${linkWt ?? ""}` : null;
  const appliedLinkKeyRef = useRef<string | null>(null);
  // A slug the inventory already missed stays failed instead of re-asking on
  // every snapshot arrival; a late snapshot that knows it can still resolve.
  const failedLinkKeyRef = useRef<string | null>(null);
  const linkKeyRef = useRef(linkKey);
  if (linkKeyRef.current !== linkKey) {
    linkKeyRef.current = linkKey;
    appliedLinkKeyRef.current = null;
    failedLinkKeyRef.current = null;
  }

  useEffect(() => {
    setFocusedLines(initialLine && initialLine > 0
      ? {
          line: initialLine,
          ...(initialEndLine && initialEndLine >= initialLine ? { endLine: initialEndLine } : {}),
        }
      : null);
  }, [initialEndLine, initialLine]);

  useEffect(() => {
    if (snapshot) return;
    let cancelled = false;
    fetchRepoWatchSnapshot("quick", false, 20_000)
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        // Repo picker degrades to the ?root= prop; the tree still works.
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  const loadDir = useCallback(async (dir: string) => {
    try {
      const preview = await api<FilePreviewResponse>(`/api/file/preview?path=${encodeURIComponent(dir)}`);
      if (preview.kind !== "directory") return;
      const entries = preview.entries.map((entry) => ({ name: entry.name, path: entry.path, kind: entry.kind }));
      setChildrenByPath((current) => new Map(current).set(dir, entries));
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  /** Reveal a link target: expand + load every directory above it. */
  const revealPath = useCallback((rootPath: string, filePath: string | null) => {
    if (!filePath) return;
    const dirs = ancestorDirs(rootPath, filePath);
    if (dirs.length === 0) return;
    setExpanded((current) => new Set([...current, ...dirs]));
    for (const dir of dirs) {
      void loadDir(dir);
    }
  }, [loadDir]);

  // Resolve /code/<project>/<path> links: the repo-watch snapshot answers
  // first when it can (it knows worktrees), otherwise the server's project
  // inventory is the authority — repo-watch only registers checkouts with
  // live agent activity, so a quiet-but-known checkout must still resolve.
  useEffect(() => {
    if (!linkProject) return;
    const key = `${linkProject}\0${linkPath ?? ""}\0${linkWt ?? ""}`;
    if (appliedLinkKeyRef.current === key) return;
    const applyTarget = (rootPath: string) => {
      appliedLinkKeyRef.current = key;
      const target = linkPath ? `${rootPath}/${linkPath}` : null;
      setLinkResolution({ phase: "idle" });
      setRoot(rootPath);
      setSelectedFile(target);
      revealPath(rootPath, target);
    };
    if (snapshot) {
      const resolved = resolveProjectLink(snapshot, linkProject, linkWt);
      if (resolved) {
        applyTarget(resolved.root);
        return;
      }
    }
    if (failedLinkKeyRef.current === key) return;
    setLinkResolution({ phase: "resolving" });
    // api() dedupes concurrent identical GETs, so snapshot-arrival re-runs
    // while this is in flight share one request instead of stacking.
    api<{ ok: true; projectName: string; root: string }>(
      `/api/code/resolve-project?slug=${encodeURIComponent(linkProject)}`,
    )
      .then((resolved) => {
        if (appliedLinkKeyRef.current === key || linkKeyRef.current !== key) return;
        applyTarget(resolved.root);
      })
      .catch((error) => {
        if (appliedLinkKeyRef.current === key || linkKeyRef.current !== key) return;
        failedLinkKeyRef.current = key;
        const message = error instanceof Error ? error.message : String(error);
        setLinkResolution({
          phase: "failed",
          message: message.includes(linkProject)
            ? message
            : `Can't resolve project "${linkProject}": ${message}`,
        });
      });
  }, [linkProject, linkPath, linkWt, snapshot, revealPath]);

  // Default to the first known worktree when nothing was requested explicitly.
  useEffect(() => {
    if (root || linkProject || !snapshot) return;
    const first = snapshot.projects[0];
    if (!first) return;
    setRoot(first.worktrees[0]?.path ?? first.root);
  }, [root, linkProject, snapshot]);

  // Root switched: hydrate instantly from the last visit (stale), then
  // re-fetch every visible directory in the background — loadDir replaces one
  // directory at a time, which reconciles the stale render against disk.
  // A link target inside the new root still wins over restored state.
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  useEffect(() => {
    if (!root) return;
    setTreeError(null);
    const stored = readStoredTree(root);
    const target = selectedFileRef.current;
    const linkDirs = target ? ancestorDirs(root, target) : [];
    if (stored) {
      setChildrenByPath(new Map(Object.entries(stored.entries)));
      setExpanded(new Set([...stored.expanded, ...linkDirs]));
      if (!target && stored.selectedFile) {
        setSelectedFile(stored.selectedFile);
      }
    } else {
      setChildrenByPath(new Map());
      setExpanded(new Set(linkDirs));
    }
    const refresh = new Set([root, ...(stored?.expanded ?? []), ...linkDirs]);
    for (const dir of refresh) {
      void loadDir(dir);
    }
    // Refresh git-status decorations alongside the tree.
    fetchRepoWatchSnapshot("quick", false, 20_000)
      .then(setSnapshot)
      .catch(() => {});
  }, [root, loadDir]);

  // Persist what's on screen so the next visit renders without a fetch.
  useEffect(() => {
    if (!root || childrenByPath.size === 0) return;
    writeStoredTree(root, { entries: childrenByPath, expanded, selectedFile });
    writeLastRoot(root);
  }, [root, childrenByPath, expanded, selectedFile]);

  // Absolute ?root=&file= links get the same tree reveal as slug links.
  useEffect(() => {
    if (!initialRoot || !initialFile) return;
    revealPath(initialRoot, initialFile);
  }, [initialRoot, initialFile, revealPath]);

  // Short-lived preview cache + hover prefetch: revisits and hovered files
  // render with zero round trips, which is what makes browsing feel local.
  // TTL stays short because agents actively rewrite these files.
  const previewCacheRef = useRef(new Map<string, { at: number; preview: FilePreviewResponse }>());
  const prefetchInFlightRef = useRef(new Set<string>());
  const PREVIEW_TTL_MS = 30_000;

  const cachedPreview = useCallback((path: string): FilePreviewResponse | null => {
    const hit = previewCacheRef.current.get(path);
    if (!hit) return null;
    if (Date.now() - hit.at > PREVIEW_TTL_MS) {
      previewCacheRef.current.delete(path);
      return null;
    }
    return hit.preview;
  }, []);

  const storePreview = useCallback((path: string, preview: FilePreviewResponse) => {
    const cache = previewCacheRef.current;
    cache.set(path, { at: Date.now(), preview });
    if (cache.size > 80) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }, []);

  const prefetchFile = useCallback((path: string) => {
    if (cachedPreview(path) || prefetchInFlightRef.current.has(path)) return;
    prefetchInFlightRef.current.add(path);
    api<FilePreviewResponse>(`/api/file/preview?path=${encodeURIComponent(path)}`)
      .then((preview) => storePreview(path, preview))
      .catch(() => {
        // Prefetch is best-effort; the click path reports real errors.
      })
      .finally(() => prefetchInFlightRef.current.delete(path));
  }, [cachedPreview, storePreview]);

  useEffect(() => {
    setCopyStatus("idle");
    if (!selectedFile) {
      setFilePreview(null);
      setFileError(null);
      return;
    }
    const cached = cachedPreview(selectedFile);
    if (cached) {
      setFilePreview(cached.kind === "file" ? cached : null);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    setFileError(null);
    api<FilePreviewResponse>(`/api/file/preview?path=${encodeURIComponent(selectedFile)}`)
      .then((preview) => {
        if (cancelled) return;
        storePreview(selectedFile, preview);
        setFilePreview(preview.kind === "file" ? preview : null);
      })
      .catch((error) => {
        if (cancelled) return;
        setFilePreview(null);
        setFileError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile, cachedPreview, storePreview]);

  const treeRows = useMemo(() => {
    if (!root) return [];
    const rows: TreeRow[] = [];
    collectTreeRows(root, 0, childrenByPath, expanded, rows);
    return rows;
  }, [root, childrenByPath, expanded]);

  // Keep the address bar in sync with what's on screen so any moment in the
  // surface is a copyable link — slug form when the snapshot knows the root,
  // absolute form otherwise.
  const routeForSelection = useCallback((rootPath: string, filePath: string | null): Route => {
    const returnRoute = returnConversationId ? { returnConversationId } : {};
    if (snapshot) {
      for (const project of snapshot.projects) {
        for (const [index, worktree] of project.worktrees.entries()) {
          if (worktree.path === rootPath) {
            const rel = filePath && filePath.startsWith(`${rootPath}/`) ? filePath.slice(rootPath.length + 1) : undefined;
            return {
              view: "code",
              project: slugify(project.name),
              ...(rel ? { path: rel } : {}),
              ...(index > 0 ? { wt: worktree.name } : {}),
              ...returnRoute,
            };
          }
        }
      }
    }
    return { view: "code", root: rootPath, ...(filePath ? { file: filePath } : {}), ...returnRoute };
  }, [returnConversationId, snapshot]);

  const returnToThread = useCallback(() => {
    if (!returnConversationId) return;
    const destination: Route = { view: "conversation", conversationId: returnConversationId };
    if (forwardScoutbotUiActionToNativeHost({ type: "navigate", route: destination })) return;
    navigate?.(destination);
  }, [navigate, returnConversationId]);

  useEffect(() => {
    if (!returnConversationId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.metaKey || event.key !== "[") return;
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) return;
      }
      event.preventDefault();
      returnToThread();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [returnConversationId, returnToThread]);

  const syncUrl = useCallback((rootPath: string, filePath: string | null) => {
    if (embedded || !navigate) return;
    navigate(routeForSelection(rootPath, filePath));
  }, [embedded, navigate, routeForSelection]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!childrenByPath.has(path)) {
      void loadDir(path);
    }
  }, [childrenByPath, loadDir]);

  const selectFile = useCallback((path: string) => {
    setFocusedLines(null);
    setSelectedFile(path);
    if (root) syncUrl(root, path);
  }, [root, syncUrl]);

  const activeWorktree = useMemo(() => {
    if (!snapshot || !root) return null;
    for (const project of snapshot.projects) {
      for (const worktree of project.worktrees) {
        if (worktree.path === root) return { project, worktree };
      }
    }
    return null;
  }, [snapshot, root]);

  // Git-status decoration: repo-watch already carries this worktree's changed
  // files — tint them in the tree and dot every folder on the way down.
  const changedByPath = useMemo(() => {
    const map = new Map<string, string>();
    if (!root || !activeWorktree) return map;
    for (const file of activeWorktree.worktree.status.files) {
      map.set(`${root}/${file.path}`, file.status);
    }
    return map;
  }, [root, activeWorktree]);

  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    if (!root) return dirs;
    for (const path of changedByPath.keys()) {
      let current = parentDir(path);
      while (current.startsWith(root)) {
        dirs.add(current);
        if (current === root) break;
        current = parentDir(current);
      }
    }
    return dirs;
  }, [root, changedByPath]);

  // Repo Watch intentionally caps its per-file preview list and may still be
  // warming when an explicit ?root= link opens. The path-filtered Git request
  // is authoritative, so every rooted file gets the Changes affordance.
  const canShowChanges = Boolean(
    root && selectedFile && relativeFilePath(root, selectedFile),
  );

  useEffect(() => {
    // Preserve the operator's mode while stepping through rooted files; reset
    // to Source once there is no file target for Changes to render.
    if (!canShowChanges) setFileMode("source");
  }, [canShowChanges]);

  const relativeTitle = selectedFile && root && selectedFile.startsWith(`${root}/`)
    ? selectedFile.slice(root.length + 1)
    : filePreview?.kind === "file"
      ? filePreview.title
      : selectedFile ? pathLeaf(selectedFile) : null;

  const copyFile = useCallback(async () => {
    if (!filePreview || filePreview.kind !== "file" || !filePreview.previewable) return;
    const copied = await copyTextToClipboard(filePreview.content);
    if (copied) {
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1500);
    }
  }, [filePreview]);

  const [linkCopyStatus, setLinkCopyStatus] = useState<"idle" | "copied">("idle");

  const scoutDeepLink = useMemo(() => {
    if (!root) return null;
    if (activeWorktree) {
      const rel = selectedFile && selectedFile.startsWith(`${root}/`)
        ? selectedFile.slice(root.length + 1)
        : undefined;
      const primaryPath = activeWorktree.project.worktrees[0]?.path;
      return formatScoutCodeDeepLink({
        project: slugify(activeWorktree.project.name),
        ...(rel ? { path: rel } : {}),
        ...(primaryPath && primaryPath !== root ? { wt: activeWorktree.worktree.name } : {}),
        ...(focusedLines?.line ? { line: focusedLines.line } : {}),
        ...(focusedLines?.endLine ? { endLine: focusedLines.endLine } : {}),
      });
    }
    return formatScoutCodeDeepLink({
      ...(selectedFile ? { file: selectedFile } : { root }),
      ...(focusedLines?.line ? { line: focusedLines.line } : {}),
      ...(focusedLines?.endLine ? { endLine: focusedLines.endLine } : {}),
    });
  }, [root, selectedFile, activeWorktree, focusedLines]);

  const copyDeepLink = useCallback(async () => {
    if (!scoutDeepLink) return;
    const copied = await copyTextToClipboard(scoutDeepLink);
    if (copied) {
      setLinkCopyStatus("copied");
      window.setTimeout(() => setLinkCopyStatus("idle"), 1500);
    }
  }, [scoutDeepLink]);

  const selectFromPicker = useCallback((selection: CodePickerSelection) => {
    // A manual pick supersedes any still-unresolved deep link.
    appliedLinkKeyRef.current = linkKeyRef.current;
    setLinkResolution({ phase: "idle" });
    setFocusedLines(
      selection.line && selection.line > 0
        ? {
            line: selection.line,
            ...(selection.endLine && selection.endLine >= selection.line
              ? { endLine: selection.endLine }
              : {}),
          }
        : null,
    );
    setSelectedFile(selection.file ?? null);
    setRoot(selection.root);
    if (selection.file) {
      revealPath(selection.root, selection.file);
    }
    syncUrl(selection.root, selection.file ?? null);
  }, [revealPath, syncUrl]);

  return (
    <div className="s-code-screen" data-embedded={embedded || undefined}>
      <div className="s-code-head">
        {returnConversationId ? (
          <button
            type="button"
            className="s-code-returnThread"
            onClick={returnToThread}
            title="Back to thread (⌘[)"
          >
            <ArrowLeft size={13} strokeWidth={1.9} aria-hidden />
            <span>Back to thread</span>
          </button>
        ) : null}
        <CodeProjectPicker
          snapshot={snapshot}
          root={root}
          onSelect={selectFromPicker}
        />
        {activeWorktree?.worktree.diff.branchShortstat ? (
          <span className="s-code-headStat">{activeWorktree.worktree.diff.branchShortstat}</span>
        ) : null}
        {root ? <span className="s-code-headPath" title={root}>{shortRootPath(root)}</span> : null}
        {scoutDeepLink ? (
          <button
            type="button"
            className="s-code-copyLink"
            title={scoutDeepLink}
            onClick={() => void copyDeepLink()}
          >
            {linkCopyStatus === "copied" ? "Copied scout://" : "Copy scout://"}
          </button>
        ) : null}
      </div>
      <div className="s-code-body">
        <div className="s-code-tree" role="tree" aria-label="Files">
          {treeError ? (
            <div className="s-code-treeNote">{treeError}</div>
          ) : root ? (
            treeRows.map((row) =>
              row.loading ? (
                <div key={row.path} className="s-code-node s-code-node--loading" style={{ paddingLeft: 10 + row.depth * 14 }}>
                  {row.name}
                </div>
              ) : (
                <button
                  key={row.path}
                  type="button"
                  role="treeitem"
                  className="s-code-node"
                  data-selected={row.path === selectedFile || undefined}
                  data-diff={row.kind === "file" ? changedByPath.get(row.path) : undefined}
                  aria-expanded={row.kind === "directory" ? expanded.has(row.path) : undefined}
                  style={{ paddingLeft: 10 + row.depth * 14 }}
                  onClick={() => (row.kind === "directory" ? toggleDir(row.path) : selectFile(row.path))}
                  onMouseEnter={row.kind === "file" ? () => prefetchFile(row.path) : undefined}
                >
                  {row.kind === "directory" ? (
                    <ChevronRight
                      size={11}
                      strokeWidth={2}
                      className="s-code-nodeChevron"
                      data-open={expanded.has(row.path) || undefined}
                      aria-hidden
                    />
                  ) : (
                    <span className="s-code-nodeSpacer" aria-hidden />
                  )}
                  <span className="s-code-nodeName">{row.name}</span>
                  {row.kind === "file" && changedByPath.has(row.path) ? (
                    <span className="s-code-nodeBadge" data-diff={changedByPath.get(row.path)}>
                      {diffBadge(changedByPath.get(row.path) ?? "")}
                    </span>
                  ) : null}
                  {row.kind === "directory" && changedDirs.has(row.path) ? (
                    <span className="s-code-nodeDot" aria-label="Contains changes" />
                  ) : null}
                </button>
              ),
            )
          ) : linkResolution.phase === "resolving" ? (
            <div className="s-code-treeNote">Resolving “{linkProject}”…</div>
          ) : linkResolution.phase === "failed" ? (
            <div className="s-code-treeNote">{linkResolution.message}</div>
          ) : (
            <div className="s-code-treeNote">No repo selected.</div>
          )}
        </div>
        <div className="s-code-main">
          {selectedFile ? (
            <div className="s-code-fileHead">
              <span className="s-code-filePath">{relativeTitle}</span>
              {canShowChanges ? (
                <div className="s-code-fileMode" role="tablist" aria-label="File view">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={fileMode === "source"}
                    data-selected={fileMode === "source" || undefined}
                    onClick={() => setFileMode("source")}
                  >
                    Source
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={fileMode === "changes"}
                    data-selected={fileMode === "changes" || undefined}
                    onClick={() => setFileMode("changes")}
                  >
                    Changes
                  </button>
                </div>
              ) : null}
              {filePreview?.kind === "file" ? (
                <span className="s-code-fileMeta">
                  {formatBytes(filePreview.sizeBytes)}
                  {filePreview.previewable && filePreview.truncated ? " · truncated" : ""}
                  {focusedLines ? ` · L${focusedLines.line}${focusedLines.endLine ? `–${focusedLines.endLine}` : ""}` : ""}
                </span>
              ) : null}
              {filePreview?.kind === "file" && filePreview.previewable ? (
                <>
                  <button
                    type="button"
                    className="s-code-fileAction"
                    onClick={() => void copyFile()}
                    title="Copy file contents"
                  >
                    {copyStatus === "copied" ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    {copyStatus === "copied" ? "Copied" : "Copy"}
                  </button>
                  <a className="s-code-fileAction" href={filePreview.rawUrl} target="_blank" rel="noreferrer">
                    Raw
                  </a>
                </>
              ) : null}
            </div>
          ) : null}
          {fileMode === "changes" && canShowChanges && root && selectedFile ? (
            <CodeDiffPane key={`${root}\0${selectedFile}`} root={root} file={selectedFile} />
          ) : fileLoading ? (
            <div className="s-code-empty">Loading {selectedFile ? pathLeaf(selectedFile) : "file"}…</div>
          ) : fileError ? (
            <div className="s-code-empty">{fileError}</div>
          ) : filePreview && filePreview.kind === "file" && filePreview.previewable ? (
            <>
              {filePreview.truncated ? (
                <div className="s-code-fileNote">
                  Showing the first {formatBytes(256 * 1024)} of {formatBytes(filePreview.sizeBytes)} ·{" "}
                  <a href={filePreview.rawUrl} target="_blank" rel="noreferrer">open raw</a>
                </div>
              ) : null}
              <ShikiPane
                code={filePreview.content}
                path={filePreview.path}
                focusLine={focusedLines?.line}
                endLine={focusedLines?.endLine}
              />
            </>
          ) : filePreview && filePreview.kind === "file" ? (
            <div className="s-code-empty">
              {filePreview.previewReason} · {formatBytes(filePreview.sizeBytes)} ·{" "}
              <a href={filePreview.rawUrl} target="_blank" rel="noreferrer">open raw</a>
            </div>
          ) : linkResolution.phase === "resolving" ? (
            <div className="s-code-empty">Opening {linkPath ?? `“${linkProject}”`}…</div>
          ) : linkResolution.phase === "failed" ? (
            <div className="s-code-empty">{linkResolution.message}</div>
          ) : (
            <div className="s-code-empty">Pick a file to read.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export const scoutSurface = defineSurface({
  id: "code",
  label: "Code Browser",
  route: { view: "code" },
  webPath: "/code",
  screen: "CodeContent",
  embed: {
    path: "/embed/code",
    profile: "macos.code",
    rootClassName: "s-code-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    hosts: { macos: true },
    resolveEmbedProps: (params) => ({
      root: params.get("root")?.trim() || undefined,
      file: params.get("file")?.trim() || undefined,
      project: params.get("project")?.trim() || undefined,
      path: params.get("path")?.trim() || undefined,
      wt: params.get("wt")?.trim() || undefined,
      line: positiveEmbedLine(params.get("line")),
      endLine: positiveEmbedLine(params.get("endLine")),
      returnConversationId: params.get("fromConversation")?.trim() || undefined,
    }),
  },
});

function positiveEmbedLine(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
