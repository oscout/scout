import { type FileRenderer } from "./types.ts";

export const ImageRenderer: FileRenderer = {
  id: "image",
  canHandle: (resource) => resource.kind === "file" && resource.mediaType.startsWith("image/"),
  render: ({ resource }) => (
    <div className="s-file-preview-image-wrap">
      <div className="s-file-preview-image-stage">
        <img
          className="s-file-preview-image"
          src={resource.kind === "file" ? resource.rawUrl : ""}
          alt={resource.title}
        />
      </div>
    </div>
  ),
};
