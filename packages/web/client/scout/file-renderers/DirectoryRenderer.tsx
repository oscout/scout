import { ChevronRight, FileText, Folder } from "lucide-react";

import {
  type DirectoryFilePreviewContent,
  type FileRenderer,
} from "./types.ts";

export const DirectoryRenderer: FileRenderer = {
  id: "directory",
  canHandle: (resource) => resource.kind === "directory",
  render: ({ resource, openFilePreview }) => {
    const content = resource as DirectoryFilePreviewContent;
    const breadcrumbs = buildBreadcrumbs(content.realPath, content.rootPath);

    return (
      <div className="s-file-preview-directory">
        <div className="s-file-preview-breadcrumb" aria-label="Directory breadcrumb">
          {breadcrumbs.map((crumb, index) => {
            const active = index === breadcrumbs.length - 1;
            return (
              <div key={crumb.path} className="s-file-preview-breadcrumb-item">
                {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
                {active
                  ? <span className="s-file-preview-breadcrumb-current">{crumb.label}</span>
                  : (
                      <button type="button" className="s-file-preview-breadcrumb-link" onClick={() => openFilePreview(crumb.path)}>
                        {crumb.label}
                      </button>
                    )}
              </div>
            );
          })}
        </div>
        <div className="s-file-preview-directory-list" role="list">
          {content.entries.map((entry) => (
            <button
              key={entry.realPath}
              type="button"
              className="s-file-preview-entry"
              onClick={() => openFilePreview(entry.path)}
            >
              <span className="s-file-preview-entry-icon" aria-hidden="true">
                {entry.kind === "directory" ? <Folder size={14} /> : <FileText size={14} />}
              </span>
              <span className="s-file-preview-entry-name">{entry.name}</span>
              <span className="s-file-preview-entry-kind">{entry.kind === "directory" ? "dir" : "file"}</span>
            </button>
          ))}
          {content.entries.length === 0 && (
            <div className="s-file-preview-directory-empty">This directory is empty.</div>
          )}
        </div>
      </div>
    );
  },
};

function buildBreadcrumbs(realPath: string, rootPath: string): Array<{ label: string; path: string }> {
  const normalizedRoot = rootPath === "/" ? "/" : rootPath.replace(/\/+$/u, "");
  const normalizedReal = realPath === "/" ? "/" : realPath.replace(/\/+$/u, "");
  const rootParts = normalizedRoot.split("/").filter(Boolean);
  const realParts = normalizedReal.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [{
    label: rootParts[rootParts.length - 1] ?? "/",
    path: normalizedRoot || "/",
  }];
  let current = normalizedRoot || "/";
  for (let index = rootParts.length; index < realParts.length; index += 1) {
    const part = realParts[index];
    if (!part) continue;
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}
