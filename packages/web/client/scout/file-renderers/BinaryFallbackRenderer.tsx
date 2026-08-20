import { type BinaryFilePreviewContent, type FileRenderer } from "./types.ts";

export const BinaryFallbackRenderer: FileRenderer = {
  id: "binary",
  canHandle: () => true,
  render: ({ resource }) => {
    const content = resource as BinaryFilePreviewContent;
    return (
      <div className="s-file-preview-callout">
        <div className="s-file-preview-callout-title">{content.previewReason} — open in OS</div>
        <div className="s-file-preview-callout-copy">
          Scout can resolve this file, but it does not have an inline preview for {content.mediaType} yet.
        </div>
      </div>
    );
  },
};
