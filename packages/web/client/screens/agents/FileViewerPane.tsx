import { useEffect, useMemo, useState } from "react";
import {
  createTextDocument,
  TextDocumentSurface,
} from "../../components/TextDocumentSurface.tsx";
import { api } from "../../lib/api.ts";
import type { FilePreviewContent, TextFilePreviewContent } from "../../scout/file-renderers/types.ts";
import type { ProjectOverviewPayload } from "../projects/project-overview-helpers.ts";

export type ViewableProjectFile = Pick<
  ProjectOverviewPayload["artifacts"][number],
  "relativePath" | "absolutePath" | "excerpt"
>;

function documentFromArtifact(
  artifact: ViewableProjectFile,
  content: string,
  truncated: boolean,
) {
  const isMarkdown = artifact.relativePath.endsWith(".md") || artifact.relativePath.endsWith(".mdx");
  const isJson = artifact.relativePath.endsWith(".json");
  return createTextDocument({
    id: artifact.absolutePath,
    title: artifact.relativePath,
    uri: artifact.absolutePath,
    filename: artifact.relativePath.split("/").pop(),
    kind: isMarkdown ? "markdown" : isJson ? "code" : "code",
    language: isJson ? "json" : isMarkdown ? "markdown" : "plain",
    value: truncated ? `${content}\n\n— excerpt —` : content,
    readOnly: true,
  });
}

export function FileViewerPane({
  artifact,
  onOpen,
  onReveal,
  onBrowse,
}: {
  artifact: ViewableProjectFile;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onBrowse?: (path: string) => void;
}) {
  const [content, setContent] = useState<string | null>(artifact.excerpt);
  const [truncated, setTruncated] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(artifact.excerpt);
    setTruncated(true);
    setError(null);
    let cancelled = false;
    setLoading(true);
    api<FilePreviewContent>(`/api/file/preview?path=${encodeURIComponent(artifact.absolutePath)}`)
      .then((preview) => {
        if (cancelled) return;
        if (preview.kind === "file" && preview.previewable) {
          const text = preview as TextFilePreviewContent;
          setContent(text.content);
          setTruncated(text.truncated);
        } else if (artifact.excerpt) {
          setContent(artifact.excerpt);
          setTruncated(true);
        } else {
          setContent(null);
          setError("Preview not available for this file type.");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (artifact.excerpt) {
          setContent(artifact.excerpt);
          setTruncated(true);
        } else {
          setError(err instanceof Error ? err.message : "Could not load file.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.absolutePath, artifact.excerpt]);

  const document = useMemo(() => {
    if (!content) return null;
    return documentFromArtifact(artifact, content, truncated);
  }, [artifact, content, truncated]);

  const isMarkdown = artifact.relativePath.endsWith(".md") || artifact.relativePath.endsWith(".mdx");

  return (
    <>
      <header className="av2-repoViewerHead">
        <div className="av2-repoViewerPath">
          <span className="av2-repoViewerPathFile">{artifact.relativePath}</span>
          <span className="av2-repoViewerPathAbs" title={artifact.absolutePath}>
            {artifact.absolutePath}
          </span>
        </div>
        <div className="av2-repoViewerActs">
          <button type="button" className="av2-repoViewerAct" data-primary onClick={() => onOpen(artifact.absolutePath)}>
            open
          </button>
          {onBrowse ? (
            <button type="button" className="av2-repoViewerAct" onClick={() => onBrowse(artifact.absolutePath)}>
              browse
            </button>
          ) : null}
          <button type="button" className="av2-repoViewerAct" onClick={() => void onReveal(artifact.absolutePath)}>
            reveal
          </button>
        </div>
      </header>
      <div className="av2-repoViewerBody">
        {loading && !content ? (
          <div className="av2-repoViewerState">Loading file…</div>
        ) : error && !content ? (
          <div className="av2-repoViewerState av2-repoViewerState--error">{error}</div>
        ) : document ? (
          <TextDocumentSurface
            document={document}
            mode={isMarkdown ? "preview" : "read"}
            className="av2-repoViewerDoc"
          />
        ) : (
          <div className="av2-repoViewerState">No content.</div>
        )}
        {truncated ? (
          <div className="av2-repoViewerNotice">Showing excerpt — use open for the full file.</div>
        ) : null}
      </div>
    </>
  );
}
