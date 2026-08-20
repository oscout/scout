import {
  createTextDocument,
  TextDocumentSurface,
} from "../../components/TextDocumentSurface.tsx";
import { type FileRenderer, type TextFilePreviewContent } from "./types.ts";

const CODE_MEDIA_TYPES = new Set([
  "text/typescript",
  "text/javascript",
  "text/css",
  "text/html",
  "application/json",
  "text/yaml",
  "text/toml",
  "text/x-shellscript",
  "text/plain",
]);

export const CodeRenderer: FileRenderer = {
  id: "code",
  canHandle: (resource) =>
    resource.kind === "file"
    && resource.previewable
    && CODE_MEDIA_TYPES.has(resource.mediaType),
  render: ({ resource }) => {
    const content = resource as TextFilePreviewContent;
    const document = createTextDocument({
      id: content.realPath,
      title: content.title,
      uri: content.realPath,
      mediaType: content.mediaType,
      value: content.content,
      filename: content.title,
      kind: "code",
      readOnly: true,
    });

    return (
      <TextDocumentSurface
        document={document}
        mode="read"
        className="s-doc-focus-document"
      />
    );
  },
};
