import {
  createTextDocument,
  TextDocumentSurface,
} from "../../components/TextDocumentSurface.tsx";
import { type FileRenderer, type TextFilePreviewContent } from "./types.ts";

export const MarkdownRenderer: FileRenderer = {
  id: "markdown",
  canHandle: (resource) =>
    resource.kind === "file"
    && resource.previewable
    && resource.mediaType === "text/markdown",
  render: ({ resource }) => {
    const content = resource as TextFilePreviewContent;
    const document = createTextDocument({
      id: content.realPath,
      title: content.title,
      uri: content.realPath,
      mediaType: content.mediaType,
      value: content.content,
      filename: content.title,
      kind: "markdown",
      readOnly: true,
    });

    return (
      <TextDocumentSurface
        document={document}
        mode="preview"
        className="s-doc-focus-document"
      />
    );
  },
};
