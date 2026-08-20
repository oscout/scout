const MD_PATTERNS: Array<[RegExp, string]> = [
  [/```[\s\S]*?```/g, " "],
  [/`([^`]+)`/g, "$1"],
  [/!\[([^\]]*)\]\([^)]+\)/g, "$1"],
  [/\[([^\]]+)\]\([^)]+\)/g, "$1"],
  [/\*\*(.+?)\*\*/g, "$1"],
  [/__(.+?)__/g, "$1"],
  [/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, "$1"],
  [/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, "$1"],
  [/~~(.+?)~~/g, "$1"],
  [/^#{1,6}\s+/gm, ""],
  [/^>\s?/gm, ""],
  [/^[-*+]\s+/gm, ""],
  [/^\d+\.\s+/gm, ""],
  [/^---+\s*$/gm, ""],
  [/^\s*\|.*\|\s*$/gm, ""],
];

export function plainPreview(text: string | null | undefined, maxLen = 140): string {
  if (!text) return "";
  let out = text;
  for (const [re, sub] of MD_PATTERNS) out = out.replace(re, sub);
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 1)}…`;
  return out;
}
