import { AudioRenderer } from "./AudioRenderer.tsx";
import { BinaryFallbackRenderer } from "./BinaryFallbackRenderer.tsx";
import { CodeRenderer } from "./CodeRenderer.tsx";
import { DirectoryRenderer } from "./DirectoryRenderer.tsx";
import { HtmlRenderer } from "./HtmlRenderer.tsx";
import { ImageRenderer } from "./ImageRenderer.tsx";
import { MarkdownRenderer } from "./MarkdownRenderer.tsx";
import { VideoRenderer } from "./VideoRenderer.tsx";

export {
  type FilePreviewContent,
  type FilePreviewEntry,
  type FileRenderer,
  type FileRendererContext,
} from "./types.ts";

export const fileRenderers = [
  DirectoryRenderer,
  MarkdownRenderer,
  HtmlRenderer,
  CodeRenderer,
  ImageRenderer,
  VideoRenderer,
  AudioRenderer,
  BinaryFallbackRenderer,
];
