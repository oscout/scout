import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { RepoWatchSnapshot } from "../../scout/repo-watch/types.ts";
import {
  formatScoutCodeDeepLink,
  looksLikeCodeDeepLink,
  matchRootForAbsolutePath,
  parseScoutCodeDeepLink,
  type ScoutCodeDeepLink,
} from "./code-deep-link.ts";
import {
  filterProjectOptions,
  flattenProjectOptions,
  optionChipLabel,
  optionDetailLabel,
  shortRootPath,
  type CodeProjectOption,
} from "./code-project-picker-model.ts";
import { readRecentRoots } from "./code-tree-store.ts";

const RECENT_CHIP_LIMIT = 6;
const RESULT_LIMIT = 12;

/** Selection emitted by the picker — project chip or a resolved deep link. */
export type CodePickerSelection = {
  root: string;
  file?: string | null;
  line?: number;
  endLine?: number;
  /** Project slug when the selection came from a scout://{project}/… link. */
  project?: string;
  path?: string;
  wt?: string;
};

type CodeProjectPickerProps = {
  snapshot: RepoWatchSnapshot | null;
  root: string | null;
  onSelect: (selection: CodePickerSelection) => void;
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function pathLeaf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

/** Expand a deep link against known worktrees / project inventory. */
export function resolvePickerDeepLink(
  raw: string,
  options: CodeProjectOption[],
  snapshot: RepoWatchSnapshot | null,
): CodePickerSelection | null {
  const link = parseScoutCodeDeepLink(raw);
  if (!link) return null;

  // Absolute / bare path form.
  if (link.root || link.file) {
    const roots = options.map((option) => option.root);
    const absolute = expandTilde((link.file ?? link.root)!, roots);
    const matched = matchRootForAbsolutePath(absolute, roots);
    if (matched) {
      return {
        root: matched.root,
        file: matched.file,
        line: link.line,
        endLine: link.endLine,
      };
    }
    // Unknown absolute path: still open it as a free root/file.
    const isLikelyFile = pathLeaf(absolute).includes(".");
    return {
      root: isLikelyFile ? parentDir(absolute) : absolute,
      file: isLikelyFile ? absolute : null,
      line: link.line,
      endLine: link.endLine,
    };
  }

  // Project-relative form.
  if (link.project) {
    const resolved = resolveProjectFromSnapshot(snapshot, link.project, link.wt ?? null, options);
    if (!resolved) return null;
    const file = link.path ? `${resolved.root}/${link.path}` : null;
    return {
      root: resolved.root,
      file,
      project: link.project,
      path: link.path,
      wt: link.wt,
      line: link.line,
      endLine: link.endLine,
    };
  }

  return null;
}

/** Expand ~/… using the home prefix inferred from known worktree roots. */
function expandTilde(path: string, sampleRoots: readonly string[]): string {
  if (!path.startsWith("~/") && path !== "~") return path;
  for (const root of sampleRoots) {
    const match = root.match(/^(\/Users\/[^/]+)/) ?? root.match(/^(\/home\/[^/]+)/);
    if (match) return `${match[1]}${path.slice(1)}`;
  }
  return path;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

function resolveProjectFromSnapshot(
  snapshot: RepoWatchSnapshot | null,
  projectSlug: string,
  wt: string | null,
  options: CodeProjectOption[],
): { root: string } | null {
  if (snapshot) {
    const needle = slugify(projectSlug);
    const project = snapshot.projects.find(
      (candidate) => slugify(candidate.name) === needle || slugify(pathLeaf(candidate.root)) === needle,
    );
    if (project) {
      const worktree = wt
        ? project.worktrees.find(
          (candidate) =>
            candidate.name === wt
            || candidate.branch.name === wt
            || slugify(candidate.name) === slugify(wt),
        )
        : project.worktrees[0];
      return { root: worktree?.path ?? project.root };
    }
  }
  // Fallback: match option slugs when snapshot is still loading.
  const needle = slugify(projectSlug);
  const option = options.find((candidate) => candidate.projectSlug === needle);
  return option ? { root: option.root } : null;
}

function deepLinkLabel(link: ScoutCodeDeepLink): string {
  if (link.project) {
    return formatScoutCodeDeepLink({
      project: link.project,
      path: link.path,
      wt: link.wt,
      line: link.line,
      endLine: link.endLine,
    });
  }
  const absolute = link.file ?? link.root;
  return absolute ? shortRootPath(absolute) : "Deep link";
}

export function CodeProjectPicker({ snapshot, root, onSelect }: CodeProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [recentRoots, setRecentRoots] = useState<string[]>(() => readRecentRoots());
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const instanceId = useId().replaceAll(":", "");
  const resultsId = `code-project-results-${instanceId}`;

  const options = useMemo(
    () => flattenProjectOptions(snapshot?.projects ?? []),
    [snapshot],
  );

  const optionsByRoot = useMemo(() => {
    const map = new Map<string, CodeProjectOption>();
    for (const option of options) map.set(option.root, option);
    return map;
  }, [options]);

  const selected = root ? optionsByRoot.get(root) ?? null : null;

  useEffect(() => {
    setRecentRoots(readRecentRoots());
  }, [root, open]);

  const recentOptions = useMemo(() => {
    const list: CodeProjectOption[] = [];
    for (const recentRoot of recentRoots) {
      const option = optionsByRoot.get(recentRoot);
      if (option) list.push(option);
      if (list.length >= RECENT_CHIP_LIMIT) break;
    }
    return list;
  }, [recentRoots, optionsByRoot]);

  // When the query looks like a deep link, suppress name filtering noise and
  // surface the resolve action as the primary option.
  const deepLinkQuery = looksLikeCodeDeepLink(query);
  const parsedDeepLink = deepLinkQuery ? parseScoutCodeDeepLink(query) : null;
  const resolvedDeepLink = deepLinkQuery
    ? resolvePickerDeepLink(query, options, snapshot)
    : null;

  const results = useMemo(
    () => (deepLinkQuery ? [] : filterProjectOptions(options, query, recentRoots, RESULT_LIMIT)),
    [options, query, recentRoots, deepLinkQuery],
  );

  // Listbox rows: optional deep-link action first, then project matches.
  const rowCount = (resolvedDeepLink ? 1 : 0) + results.length;

  const bestCompletion = useMemo(() => {
    if (!query.trim() || deepLinkQuery) return "";
    const match = results.find((option) =>
      option.projectName.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()),
    );
    return match && match.projectName.length > query.length ? match.projectName : "";
  }, [query, results, deepLinkQuery]);

  useEffect(() => setCursor(0), [query, open]);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(handle);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: PointerEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open]);

  const close = () => {
    setQuery("");
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const chooseRoot = (optionRoot: string) => {
    onSelect({ root: optionRoot });
    close();
  };

  const chooseDeepLink = () => {
    if (!resolvedDeepLink) return;
    onSelect(resolvedDeepLink);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => Math.min(value + 1, Math.max(rowCount - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (resolvedDeepLink && (cursor === 0 || results.length === 0)) {
        chooseDeepLink();
        return;
      }
      const resultIndex = resolvedDeepLink ? cursor - 1 : cursor;
      if (results[resultIndex]) chooseRoot(results[resultIndex].root);
    } else if (
      event.key === "ArrowRight"
      && bestCompletion
      && event.currentTarget.selectionStart === query.length
    ) {
      event.preventDefault();
      setQuery(bestCompletion);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const triggerLabel = selected
    ? optionChipLabel(selected)
    : root
      ? shortRootPath(root)
      : "Pick a project…";

  const triggerDetail = selected ? optionDetailLabel(selected) : null;

  const deepLinkActive = Boolean(resolvedDeepLink) && cursor === 0;
  const activeOptionId = resolvedDeepLink && cursor === 0
    ? `${instanceId}-deeplink`
    : results[resolvedDeepLink ? cursor - 1 : cursor]
      ? `${instanceId}-opt-${results[resolvedDeepLink ? cursor - 1 : cursor]!.root}`
      : undefined;

  return (
    <div className="s-code-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="s-code-pickerTrigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? resultsId : undefined}
        aria-label="Project or worktree"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="s-code-pickerTriggerName">{triggerLabel}</span>
        {triggerDetail ? (
          <span className="s-code-pickerTriggerDetail">{triggerDetail}</span>
        ) : null}
        <ChevronDown size={13} aria-hidden className="s-code-pickerChevron" data-open={open || undefined} />
      </button>

      {open ? (
        <div className="s-code-pickerPanel" role="dialog" aria-label="Choose a project">
          {recentOptions.length > 0 && !deepLinkQuery ? (
            <div className="s-code-pickerRecents" aria-label="Recent projects">
              {recentOptions.map((option) => (
                <button
                  key={option.root}
                  type="button"
                  className="s-code-pickerChip"
                  data-active={option.root === root || undefined}
                  title={`${option.projectName} · ${optionDetailLabel(option)}\n${option.root}`}
                  onClick={() => chooseRoot(option.root)}
                >
                  {optionChipLabel(option)}
                </button>
              ))}
            </div>
          ) : null}

          <div className="s-code-pickerSearch">
            <Search size={13} aria-hidden className="s-code-pickerSearchIcon" />
            <div className="s-code-pickerInputStack">
              {bestCompletion ? (
                <div className="s-code-pickerGhost" aria-hidden>
                  <span>{query}</span>
                  {bestCompletion.slice(query.length)}
                </div>
              ) : null}
              <input
                ref={inputRef}
                className="s-code-pickerInput"
                type="search"
                role="combobox"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={onKeyDown}
                placeholder="Project, scout:// path, or branch…"
                aria-label="Find a project"
                aria-autocomplete="both"
                aria-expanded="true"
                aria-controls={resultsId}
                aria-activedescendant={activeOptionId}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {bestCompletion ? <kbd className="s-code-pickerHint">→</kbd> : null}
          </div>

          <div className="s-code-pickerHeading">
            <span>
              {deepLinkQuery
                ? (resolvedDeepLink ? "Deep link" : "Unrecognized link")
                : query.trim()
                  ? (results.length ? "Matches" : "No matches")
                  : "All projects"}
            </span>
            <span>
              {deepLinkQuery
                ? (resolvedDeepLink ? "open with ↵" : "no match")
                : query.trim()
                  ? `${results.length} shown`
                  : options.length
                    ? `${Math.min(results.length, options.length)} of ${options.length}`
                    : snapshot
                      ? "No repos yet"
                      : "Loading…"}
            </span>
          </div>

          <div id={resultsId} className="s-code-pickerResults" role="listbox" aria-label="Projects">
            {resolvedDeepLink ? (
              <button
                id={`${instanceId}-deeplink`}
                type="button"
                role="option"
                aria-selected={deepLinkActive}
                tabIndex={-1}
                className="s-code-pickerOption s-code-pickerOption--deep"
                data-active={deepLinkActive || undefined}
                onMouseEnter={() => setCursor(0)}
                onClick={chooseDeepLink}
              >
                <span className="s-code-pickerOptionMain">
                  <strong>Open deep link</strong>
                </span>
                <span className="s-code-pickerOptionPath" title={query.trim()}>
                  {parsedDeepLink ? deepLinkLabel(parsedDeepLink) : query.trim()}
                </span>
                <span className="s-code-pickerOptionMeta">
                  {shortRootPath(resolvedDeepLink.root)}
                  {resolvedDeepLink.file ? ` · ${pathLeaf(resolvedDeepLink.file)}` : ""}
                </span>
              </button>
            ) : null}

            {results.map((option, index) => {
              const rowIndex = resolvedDeepLink ? index + 1 : index;
              const active = rowIndex === cursor;
              const isSelected = option.root === root;
              return (
                <button
                  key={option.root}
                  id={`${instanceId}-opt-${option.root}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  aria-current={isSelected || undefined}
                  tabIndex={-1}
                  className="s-code-pickerOption"
                  data-active={active || undefined}
                  data-selected={isSelected || undefined}
                  onMouseEnter={() => setCursor(rowIndex)}
                  onClick={() => chooseRoot(option.root)}
                >
                  <span className="s-code-pickerOptionMain">
                    <strong>{option.projectName}</strong>
                    {!option.isPrimary ? (
                      <span className="s-code-pickerWorktree">worktree</span>
                    ) : null}
                  </span>
                  <span className="s-code-pickerOptionPath" title={option.root}>
                    {shortRootPath(option.root)}
                  </span>
                  <span className="s-code-pickerOptionMeta">
                    {optionDetailLabel(option)}
                  </span>
                </button>
              );
            })}
          </div>

          {results.length === 0 && query.trim() && !resolvedDeepLink ? (
            <div className="s-code-pickerEmpty" role="status">
              {deepLinkQuery
                ? "Could not resolve that scout:// link. Try a project slug or absolute path."
                : `No project matches “${query}”. Try a folder name, branch, path, or scout:// link.`}
            </div>
          ) : null}

          <div className="s-code-pickerGuide">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
