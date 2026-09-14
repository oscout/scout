/** Plain-text presentation only; the original transcript is never modified. */
export function floorPreviewText(value: string | undefined, limit = 220): string {
  const source = value ?? "";
  // Remove transport/context payloads as blocks, before stripping formatting.
  // A truncated opening/body ends at the source boundary; do not show its fields.
  const metadataTags = ["in-app-browser-context", "environment_context", "app-context",
    "recommended_plugins", "system-reminder", "local-command-caveat", "turn_aborted",
    "transcript_delta", "current_date", "timezone", "cwd", "shell", "filesystem"];
  let presentation = source;
  for (const tag of metadataTags) {
    const block = new RegExp(`<${tag}\\b[^>]*(?:>|$)[\\s\\S]*?(?:<\\/${tag}\\s*>|(?=\\n\\s*## My request:)|$)`, "gi");
    presentation = presentation.replace(block, " ");
    presentation = presentation.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), " ");
  }
  const hasImage = /<image\b|!\[[^\]]*\]\(/i.test(presentation);
  const clean = presentation
    .replace(/<image\b[^>]*(?:>[\s\S]*?<\/image\s*>|\/?>|$)/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(?:input|transcript_delta|realtime_delegation)\b[^>]*>/gi, " ")
    .replace(/\[(?:STATUS|COMPLETE)\]/g, " ")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ").trim();
  const result = clean || (hasImage ? "Image attached" : "");
  return result.length > limit ? `${result.slice(0, limit - 1).trimEnd()}…` : result;
}
