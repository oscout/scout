const LOCAL_NODE_QUALIFIERS = new Set([
  "air-local",
  "local",
  "mini",
  "node",
]);

const DEFAULT_BRANCH_QUALIFIERS = new Set([
  "main",
  "master",
  "trunk",
]);

export function toSpokenScoutText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " code omitted ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?=[\s)\].,!?;:]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^\s_][^_\n]*?[^\s_]|[^\s_])_(?=[\s)\].,!?;:]|$)/g, "$1$2")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\bhttps?:\/\/[^\s)]+/gi, (match) => spokenUrl(match))
    .replace(
      /\b(session|conversation|message|flight|invocation|work)(?:\s+(?:id|ref))?\s*[:#]?\s+([a-z0-9][a-z0-9._:-]{9,})\b/gi,
      (_match, label: string, id: string) => `${label.toLowerCase()} ending in ${spellTail(id)}`,
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (match) =>
      `ID ending in ${spellTail(match)}`
    )
    .replace(/@?([a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){2,})\b/gi, (match, id: string) => {
      if (looksLikeDomain(match)) return match;
      return spokenAgentId(id);
    })
    .replace(/`([^`]+)`/g, (_match, value: string) => spokenInlineCode(value))
    .replace(/\s+/g, " ")
    .trim();
}

function spokenUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "").replace(/\./g, " dot ");
  } catch {
    return "link";
  }
}

function looksLikeDomain(value: string): boolean {
  const normalized = value.replace(/^@/, "").toLowerCase();
  return /\.(com|app|dev|org|net|io|local)(?:\b|\/)/.test(normalized)
    && !normalized.endsWith(".air-local");
}

function spokenAgentId(value: string): string {
  const parts = value.split(".").filter(Boolean);
  if (parts.length < 2) return value;

  const meaningful = [...parts];
  while (meaningful.length > 1 && LOCAL_NODE_QUALIFIERS.has(meaningful.at(-1)!.toLowerCase())) {
    meaningful.pop();
  }

  const [name, ...qualifiers] = meaningful;
  const spokenQualifiers = qualifiers
    .filter((part) => !DEFAULT_BRANCH_QUALIFIERS.has(part.toLowerCase()))
    .map(spokenWords)
    .filter(Boolean);

  return [spokenWords(name), ...spokenQualifiers].filter(Boolean).join(", ");
}

function spokenInlineCode(value: string): string {
  if (/^[a-z0-9][a-z0-9._:-]{12,}$/i.test(value)) {
    return `ID ending in ${spellTail(value)}`;
  }
  return spokenWords(value);
}

function spellTail(value: string): string {
  const compact = value.replace(/[^a-z0-9]/gi, "");
  const tail = compact.slice(-4) || value.slice(-4);
  return tail.split("").join(" ");
}

function spokenWords(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
