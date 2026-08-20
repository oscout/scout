import {
  type BinaryFilePreviewContent,
  type FileRenderer,
  type TextFilePreviewContent,
} from "./types.ts";

export const VideoRenderer: FileRenderer = {
  id: "video",
  canHandle: (resource) => resource.kind === "file" && resource.mediaType.startsWith("video/"),
  render: ({ resource }) => {
    const content = resource as TextFilePreviewContent | BinaryFilePreviewContent;
    return (
      <div className="s-file-preview-media-wrap">
        <div className="s-file-preview-media-stage">
          <video className="s-file-preview-video" src={content.rawUrl} controls />
        </div>
      </div>
    );
  },
};
