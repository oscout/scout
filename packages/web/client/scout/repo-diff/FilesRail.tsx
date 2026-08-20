import { Plus } from "lucide-react";
import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  fileDisplayPath,
  fileKey,
  splitPath,
  STATUS_GLYPH,
} from "./model.ts";
import type {
  RepoDiffFile,
  RepoDiffLayer,
} from "./types.ts";

const RAIL_WIDTH_KEY = "openscout.repo-diff.files-rail-width";
const DEFAULT_RAIL_WIDTH = 268;
const MIN_RAIL_WIDTH = 196;
const MAX_RAIL_WIDTH = 520;

// Middle-truncate filename while preserving extension
function truncateFilename(filename: string, maxLength: number): string {
  if (filename.length <= maxLength) return filename;

  // Split at last dot to preserve extension
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    // No extension found, do simple middle truncation
    const startLen = Math.max(1, Math.floor((maxLength - 1) / 2));
    const endLen = maxLength - startLen - 1;
    return filename.slice(0, startLen) + "…" + filename.slice(-Math.max(1, endLen));
  }

  const stem = filename.slice(0, lastDot);
  const ext = filename.slice(lastDot);
  const budget = maxLength - ext.length - 1; // -1 for ellipsis

  if (budget < 2) {
    // Not enough space for meaningful stem truncation
    const headRoom = Math.max(1, maxLength - ext.length - 1);
    return stem.slice(0, headRoom) + "…" + ext;
  }

  const startLen = Math.max(1, Math.floor(budget / 2));
  const endLen = Math.max(1, budget - startLen);
  return stem.slice(0, startLen) + "…" + stem.slice(-endLen) + ext;
}

// Compute filename character budget based on rail width and tree depth.
// The budget must stay UNDER the real pixel room (row indent 18 + depth*14,
// status glyph, churn column, include button) so the CSS end-ellipsis backstop
// never fires — otherwise it re-truncates the tail and eats the extension the
// middle-truncation was preserving. Name font is 11px mono (~6.7px/char).
function getFilenameMaxLength(railWidth: number, depth: number): number {
  return Math.max(8, Math.floor((railWidth - 178 - depth * 14) / 6.7));
}

type FileEntry = {
  file: RepoDiffFile;
  index: number;
  key: string;
  display: string;
  name: string;
  dir: string;
  renamed: boolean;
};

type FileTreeNode = {
  name: string;
  path: string;
  firstIndex: number;
  children: Map<string, FileTreeNode>;
  files: FileEntry[];
};

function clampRailWidth(width: number): number {
  return Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, Math.round(width)));
}

function initialRailWidth(): number {
  if (typeof window === "undefined") return DEFAULT_RAIL_WIDTH;
  const stored = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
  return Number.isFinite(stored) ? clampRailWidth(stored) : DEFAULT_RAIL_WIDTH;
}

function buildFileTree(entries: FileEntry[]): FileTreeNode {
  const root: FileTreeNode = { name: "", path: "", firstIndex: Number.MAX_SAFE_INTEGER, children: new Map(), files: [] };
  for (const entry of entries) {
    root.firstIndex = Math.min(root.firstIndex, entry.index);
    const parts = entry.dir ? entry.dir.split("/").filter(Boolean) : [];
    let node = root;
    for (const part of parts) {
      const path = node.path ? `${node.path}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, firstIndex: entry.index, children: new Map(), files: [] };
        node.children.set(part, child);
      }
      child.firstIndex = Math.min(child.firstIndex, entry.index);
      node = child;
    }
    node.files.push(entry);
  }
  return root;
}

function treeFileCount(node: FileTreeNode): number {
  let count = node.files.length;
  for (const child of node.children.values()) count += treeFileCount(child);
  return count;
}

export function FilesRail({
  layer,
  selectedFileKey,
  onSelect,
  onIncludeFile,
}: {
  layer: RepoDiffLayer | null;
  selectedFileKey: string | null;
  onSelect: (key: string) => void;
  onIncludeFile: (file: RepoDiffFile, key: string) => void;
}) {
  const [width, setWidth] = useState(initialRailWidth);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const entries = useMemo<FileEntry[]>(() => (layer?.files ?? []).map((file, index) => {
    const key = fileKey(file, index);
    const display = fileDisplayPath(file);
    const { name, dir } = splitPath(display);
    const renamed =
      (file.status === "renamed" || file.status === "copied") &&
      file.oldPath &&
      file.newPath &&
      file.oldPath !== file.newPath;
    return { file, index, key, display, name, dir, renamed: Boolean(renamed) };
  }), [layer]);
  const tree = useMemo(() => buildFileTree(entries), [entries]);

  const toggleDirectory = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      setWidth(clampRailWidth(startWidth + moveEvent.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((current) => {
        const next = clampRailWidth(current);
        window.localStorage.setItem(RAIL_WIDTH_KEY, String(next));
        return next;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [width]);

  const renderFile = (entry: FileEntry, depth: number) => (
    <FileRow
      key={entry.key}
      entry={entry}
      depth={depth}
      railWidth={width}
      selected={entry.key === selectedFileKey}
      onSelect={onSelect}
      onIncludeFile={onIncludeFile}
    />
  );

  const renderNode = (node: FileTreeNode, depth: number): ReactNode[] => {
    const rows: ReactNode[] = [];
    const children = [...node.children.values()].sort((left, right) => {
      if (left.firstIndex !== right.firstIndex) return left.firstIndex - right.firstIndex;
      return left.name.localeCompare(right.name);
    });
    for (const child of children) {
      const isCollapsed = collapsed.has(child.path);
      rows.push(
        <button
          key={`dir:${child.path}`}
          type="button"
          className="rd-dir-row"
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => toggleDirectory(child.path)}
          title={child.path}
        >
          <span className="rd-dir-caret">{isCollapsed ? "›" : "⌄"}</span>
          <span className="rd-dir-name">{child.name}</span>
          <span className="rd-dir-count">{treeFileCount(child)}</span>
        </button>,
      );
      if (!isCollapsed) {
        rows.push(...renderNode(child, depth + 1));
      }
    }
    for (const entry of node.files) rows.push(renderFile(entry, depth));
    return rows;
  };

  return (
    <div className="rd-rail" style={{ width }}>
      <div className="rd-rail-head">
        {layer ? `Changed files · ${layer.files.length}` : "Changed files"}
      </div>
      <div className="rd-rail-list">
        {renderNode(tree, 0)}
      </div>
      <div
        className="rd-rail-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file navigation"
        onPointerDown={beginResize}
      />
    </div>
  );
}

function FileRow({
  entry,
  depth,
  railWidth,
  selected,
  onSelect,
  onIncludeFile,
}: {
  entry: FileEntry;
  depth: number;
  railWidth: number;
  selected: boolean;
  onSelect: (key: string) => void;
  onIncludeFile: (file: RepoDiffFile, key: string) => void;
}) {
  const { file, key, display, name, dir, renamed } = entry;
  const maxFileLength = getFilenameMaxLength(railWidth, depth);
  const displayName = truncateFilename(name, maxFileLength);
  return (
    <div
      className={"rd-file-row" + (selected ? " on" : "")}
      title={renamed ? `${file.oldPath} → ${file.newPath}` : display}
    >
      <button
        type="button"
        className="rd-file-pick"
        style={{ paddingLeft: 18 + depth * 14 }}
        onClick={() => onSelect(key)}
      >
        <span className={`rd-file-glyph ${file.status}`}>
          {STATUS_GLYPH[file.status]}
        </span>
        <span className="rd-file-id">
          <span className="rd-file-name">{displayName}</span>
          <span className="rd-file-dir">
            {renamed ? `${file.oldPath} → ${dir || name}` : dir}
          </span>
          <FileTags file={file} />
        </span>
      </button>
      <span className="rd-file-churn">
        {file.binary ? (
          <span className="add" style={{ color: "var(--muted)" }}>
            bin
          </span>
        ) : (
          <>
            <span className="add">+{file.additions ?? 0}</span>
            <span className="del">−{file.deletions ?? 0}</span>
          </>
        )}
      </span>
      <button
        type="button"
        className="rd-file-include"
        onClick={(event) => {
          event.stopPropagation();
          onIncludeFile(file, key);
        }}
        aria-label={`Include ${display} in comment`}
        title="Include in comment"
      >
        <Plus size={12} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

function FileTags({ file }: { file: RepoDiffFile }) {
  const tags: string[] = [];
  if (file.binary) tags.push("BINARY");
  if (file.truncated) tags.push("TRUNCATED");
  if (file.status === "conflict") tags.push("CONFLICT");
  if (tags.length === 0) return null;
  return (
    <span className="rd-file-tags">
      {tags.map((t) => (
        <span key={t} className="rd-file-tag">
          {t}
        </span>
      ))}
    </span>
  );
}
