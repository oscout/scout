import { type FileRenderer } from "./types.ts";

export const HtmlRenderer: FileRenderer = {
  id: "html",
  canHandle: (resource) =>
    resource.kind === "file"
    && resource.previewable
    && resource.mediaType === "text/html",
  render: ({ resource }) => (
    <div className="s-file-preview-html-wrap">
      <iframe
        className="s-file-preview-html-frame"
        src={resource.kind === "file" ? resource.rawUrl : ""}
        title={resource.title}
        sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts"
        referrerPolicy="no-referrer"
      />
    </div>
  ),
};
