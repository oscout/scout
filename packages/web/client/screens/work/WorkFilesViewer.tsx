import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DocumentFocusViewer } from "../../components/DocumentFocusViewer.tsx";
import {
  createTextDocument,
  TextDocumentSurface,
} from "../../components/TextDocumentSurface.tsx";
import { api } from "../../lib/api.ts";
import type {
  WorkMaterial,
  WorkMaterialContent,
  WorkMaterialKind,
} from "../../lib/types.ts";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);

type KindFilter = "all" | WorkMaterialKind;

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "plan", label: "Plans" },
  { value: "doc", label: "Docs" },
  { value: "code", label: "Code" },
  { value: "test", label: "Tests" },
  { value: "config", label: "Config" },
  { value: "asset", label: "Assets" },
];

function fileExtension(path: string): string {
  const basename = path.split("/").pop() ?? path;
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

function isImageMaterial(material: WorkMaterial): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(material.path));
}

type TreeNode =
  | {
      type: "dir";
      name: string;
      path: string;
      children: TreeNode[];
    }
  | {
      type: "file";
      name: string;
      path: string;
      material: WorkMaterial;
    };

function buildTree(materials: WorkMaterial[]): TreeNode[] {
  const root: TreeNode = { type: "dir", name: "", path: "", children: [] };
  for (const material of materials) {
    const parts = material.path.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i]!;
      const segmentPath = parts.slice(0, i + 1).join("/");
      let next = cursor.children.find(
        (child) => child.type === "dir" && child.name === segment,
      ) as Extract<TreeNode, { type: "dir" }> | undefined;
      if (!next) {
        next = { type: "dir", name: segment, path: segmentPath, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({
      type: "file",
      name: parts[parts.length - 1]!,
      path: material.path,
      material,
    });
  }
  sortTree(root);
  return collapseSingleChildDirs(root.children);
}

function sortTree(node: TreeNode): void {
  if (node.type !== "dir") {
    return;
  }
  node.children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "dir" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  for (const child of node.children) {
    sortTree(child);
  }
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type !== "dir") {
      return node;
    }
    let collapsed = node;
    while (
      collapsed.children.length === 1
      && collapsed.children[0]!.type === "dir"
    ) {
      const child = collapsed.children[0] as Extract<TreeNode, { type: "dir" }>;
      collapsed = {
        type: "dir",
        name: `${collapsed.name}/${child.name}`,
        path: child.path,
        children: child.children,
      };
    }
    return {
      ...collapsed,
      children: collapseSingleChildDirs(collapsed.children),
    };
  });
}

function statusGlyph(status: WorkMaterial["status"]): string | null {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    case "observed":
      return null;
  }
}

function TreeRow({
  node,
  depth,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (material: WorkMaterial) => void;
}) {
  if (node.type === "dir") {
    const isCollapsed = collapsed.has(node.path);
    return (
      <>
        <button
          type="button"
          className="s-work-files-tree-row s-work-files-tree-dir"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => onToggle(node.path)}
        >
          <span className="s-work-files-tree-chevron" aria-hidden="true">
            {isCollapsed
              ? <ChevronRight size={12} strokeWidth={1.8} />
              : <ChevronDown size={12} strokeWidth={1.8} />}
          </span>
          <span className="s-work-files-tree-icon" aria-hidden="true">
            {isCollapsed
              ? <Folder size={12} strokeWidth={1.8} />
              : <FolderOpen size={12} strokeWidth={1.8} />}
          </span>
          <span className="s-work-files-tree-name">{node.name || "/"}</span>
        </button>
        {!isCollapsed && node.children.map((child) => (
          <TreeRow
            key={child.type === "dir" ? `d:${child.path}` : `f:${child.material.id}`}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
      </>
    );
  }

  const isSelected = node.material.id === selectedId;
  const isImage = isImageMaterial(node.material);
  const statusBadge = statusGlyph(node.material.status);
  const isDisabled = node.material.status === "deleted";
  return (
    <button
      type="button"
      className={`s-work-files-tree-row s-work-files-tree-file${
        isSelected ? " s-work-files-tree-file-selected" : ""
      }`}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      onClick={() => onSelect(node.material)}
      disabled={isDisabled}
      title={node.path}
    >
      <span className="s-work-files-tree-chevron" aria-hidden="true" />
      <span className="s-work-files-tree-icon" aria-hidden="true">
        {isImage
          ? <ImageIcon size={12} strokeWidth={1.8} />
          : <FileText size={12} strokeWidth={1.8} />}
      </span>
      <span className="s-work-files-tree-name">{node.name}</span>
      {statusBadge && (
        <span
          className={`s-work-files-tree-status s-work-files-tree-status-${node.material.status}`}
          aria-label={node.material.status}
        >
          {statusBadge}
        </span>
      )}
    </button>
  );
}

function MaterialBreadcrumb({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return <span className="s-work-files-breadcrumb">{path}</span>;
  }
  const filename = segments[segments.length - 1]!;
  const folder = segments.slice(0, -1).join("/");
  return (
    <span className="s-work-files-breadcrumb">
      {folder && <span className="s-work-files-breadcrumb-folder">{folder}/</span>}
      <span className="s-work-files-breadcrumb-name">{filename}</span>
    </span>
  );
}

function MaterialContentPane({
  workId,
  material,
}: {
  workId: string;
  material: WorkMaterial;
}) {
  const isImage = isImageMaterial(material);
  const [content, setContent] = useState<WorkMaterialContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isImage) {
      setContent(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    void api<WorkMaterialContent>(
      `/api/work/${encodeURIComponent(workId)}/material?materialId=${encodeURIComponent(material.id)}`,
    )
      .then((next) => {
        if (!cancelled) {
          setContent(next);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isImage, material.id, workId]);

  if (isImage) {
    const src = `/api/work/${encodeURIComponent(workId)}/material/raw?materialId=${encodeURIComponent(material.id)}`;
    return (
      <div className="s-work-files-pane s-work-files-pane-image">
        <img src={src} alt={material.path} className="s-work-files-image" />
      </div>
    );
  }

  if (loading && !content) {
    return <div className="s-work-files-pane-state">Loading file…</div>;
  }
  if (error) {
    return <div className="s-work-files-pane-state s-work-files-pane-error">{error}</div>;
  }
  if (!content) {
    return <div className="s-work-files-pane-state">No content.</div>;
  }

  const document = createTextDocument({
    id: content.materialId,
    title: content.title,
    uri: content.uri,
    mediaType: content.mediaType,
    value: content.content,
    readOnly: true,
  });

  return (
    <div className="s-work-files-pane">
      <TextDocumentSurface
        document={document}
        mode={document.kind === "markdown" ? "preview" : "read"}
      />
      {content.truncated && (
        <div className="s-work-files-pane-notice">
          Preview truncated at {Math.round(content.content.length / 1024)} KB.
        </div>
      )}
    </div>
  );
}

export function WorkFilesViewer({
  workId,
  workTitle,
  materials,
  open,
  initialKind = "all",
  onClose,
}: {
  workId: string;
  workTitle: string;
  materials: WorkMaterial[];
  open: boolean;
  initialKind?: KindFilter;
  onClose: () => void;
}) {
  const viewable = useMemo(
    () => materials.filter((material) => material.status !== "deleted"),
    [materials],
  );
  const [kindFilter, setKindFilter] = useState<KindFilter>(initialKind);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (open) {
      setKindFilter(initialKind);
    }
  }, [initialKind, open]);

  const filtered = useMemo(() => {
    if (kindFilter === "all") {
      return viewable;
    }
    if (kindFilter === "plan") {
      return viewable.filter((m) => m.kind === "plan" || m.kind === "spec");
    }
    return viewable.filter((m) => m.kind === kindFilter);
  }, [viewable, kindFilter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  useEffect(() => {
    if (!selectedId && filtered.length > 0) {
      setSelectedId(filtered[0]!.id);
      return;
    }
    if (selectedId && !filtered.some((m) => m.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

  const handleSelect = useCallback((material: WorkMaterial) => {
    setSelectedId(material.id);
  }, []);

  const handleToggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const selected = filtered.find((m) => m.id === selectedId) ?? null;
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { all: viewable.length };
    for (const filter of KIND_FILTERS) {
      if (filter.value === "all") continue;
      counts[filter.value] = viewable.filter((m) => {
        if (filter.value === "plan") return m.kind === "plan" || m.kind === "spec";
        return m.kind === filter.value;
      }).length;
    }
    return counts;
  }, [viewable]);

  return (
    <DocumentFocusViewer
      open={open}
      kind="code"
      document={null}
      title={`Files · ${viewable.length}`}
      eyebrow="Work materials"
      subtitle={workTitle}
      focusable
      onClose={onClose}
      body={(
        <div className="s-work-files-layout">
          <aside className="s-work-files-tree" aria-label="File tree">
            <div className="s-work-files-tree-filters" role="tablist">
              {KIND_FILTERS.map((filter) => {
                const count = kindCounts[filter.value] ?? 0;
                if (filter.value !== "all" && count === 0) {
                  return null;
                }
                const active = filter.value === kindFilter;
                return (
                  <button
                    key={filter.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`s-work-files-tree-filter${active ? " s-work-files-tree-filter-active" : ""}`}
                    onClick={() => setKindFilter(filter.value)}
                  >
                    <span>{filter.label}</span>
                    <span className="s-work-files-tree-filter-count">{count}</span>
                  </button>
                );
              })}
            </div>
            <div className="s-work-files-tree-list">
              {tree.length === 0
                ? <div className="s-work-files-tree-empty">No files match this filter.</div>
                : tree.map((node) => (
                  <TreeRow
                    key={node.type === "dir" ? `d:${node.path}` : `f:${node.material.id}`}
                    node={node}
                    depth={0}
                    selectedId={selectedId}
                    collapsed={collapsed}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                  />
                ))}
            </div>
          </aside>
          <section className="s-work-files-content" aria-label="File preview">
            {selected ? (
              <>
                <header className="s-work-files-content-head">
                  <MaterialBreadcrumb path={selected.path} />
                  <div className="s-work-files-content-meta">
                    <span>{selected.kind}</span>
                    <span>{selected.status}</span>
                    {selected.diffStat && (
                      <span>
                        +{selected.diffStat.additions} -{selected.diffStat.deletions}
                      </span>
                    )}
                  </div>
                </header>
                <MaterialContentPane workId={workId} material={selected} />
              </>
            ) : (
              <div className="s-work-files-pane-state">Select a file to preview.</div>
            )}
          </section>
        </div>
      )}
    />
  );
}
