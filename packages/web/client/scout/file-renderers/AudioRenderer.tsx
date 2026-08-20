import {
  type BinaryFilePreviewContent,
  type FileRenderer,
  type TextFilePreviewContent,
} from "./types.ts";

export const AudioRenderer: FileRenderer = {
  id: "audio",
  canHandle: (resource) => resource.kind === "file" && resource.mediaType.startsWith("audio/"),
  render: ({ resource }) => {
    const content = resource as TextFilePreviewContent | BinaryFilePreviewContent;
    return (
      <div className="s-file-preview-media-wrap">
        <div className="s-file-preview-audio-stage">
          <audio className="s-file-preview-audio" src={content.rawUrl} controls />
        </div>
      </div>
    );
  },
};
