export type CodexHostDirectiveMetadata = {
  kind: "directive";
  name: string;
  raw: string;
};

export type CodexMemoryCitationMetadata = {
  kind: "memory_citation";
  raw: string;
  citationEntries: string[];
  rolloutIds: string[];
};

export type CodexHostMetadata = CodexHostDirectiveMetadata | CodexMemoryCitationMetadata;

const CODEX_HOST_DIRECTIVE_NAMES = new Set([
  "code-comment",
  "created-thread",
  "git-commit",
  "git-create-branch",
  "git-create-pr",
  "git-push",
  "git-stage",
]);

export function projectCodexAssistantText(rawText: string): { text: string; hostMetadata: CodexHostMetadata[] } {
  const hostMetadata: CodexHostMetadata[] = [];
  const withoutMemoryCitations = rawText.replace(
    /(^|\n)[ \t]*<oai-mem-citation>\s*[\s\S]*?<\/oai-mem-citation>[ \t]*(?=\n|$)/gu,
    (raw) => {
      const block = raw.trim();
      if (block) {
        hostMetadata.push(parseCodexMemoryCitation(block));
      }
      return "\n";
    },
  );

  const lines = withoutMemoryCitations.split(/\r?\n/u);
  const visibleLines: string[] = [];
  for (const line of lines) {
    const directive = parseCodexHostDirective(line);
    if (directive) {
      hostMetadata.push(directive);
      continue;
    }
    visibleLines.push(line);
  }

  return {
    text: collapseExcessBlankLines(visibleLines.join("\n")).trim(),
    hostMetadata,
  };
}

export function projectCodexAssistantStreamText(rawText: string): { text: string; hostMetadata: CodexHostMetadata[] } {
  const projected = projectCodexAssistantText(rawText);
  return {
    text: holdIncompleteHostMetadata(projected.text).trim(),
    hostMetadata: projected.hostMetadata,
  };
}

function parseCodexHostDirective(line: string): CodexHostDirectiveMetadata | null {
  const trimmed = line.trim();
  const match = /^::([a-z][a-z0-9-]*)\{.*\}$/u.exec(trimmed);
  if (!match) {
    return null;
  }
  const name = match[1]!;
  if (!CODEX_HOST_DIRECTIVE_NAMES.has(name)) {
    return null;
  }
  return {
    kind: "directive",
    name,
    raw: trimmed,
  };
}

function parseCodexMemoryCitation(raw: string): CodexMemoryCitationMetadata {
  return {
    kind: "memory_citation",
    raw,
    citationEntries: parseCodexCitationSection(raw, "citation_entries"),
    rolloutIds: parseCodexCitationSection(raw, "rollout_ids"),
  };
}

function parseCodexCitationSection(raw: string, tag: "citation_entries" | "rollout_ids"): string[] {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "u");
  const match = pattern.exec(raw);
  if (!match) {
    return [];
  }
  return match[1]!
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function collapseExcessBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n");
}

function holdIncompleteHostMetadata(text: string): string {
  const withoutOpenMemoryCitation = text.replace(/(^|\n)[ \t]*<oai-mem-citation>[\s\S]*$/u, "\n");
  const lines = withoutOpenMemoryCitation.split(/\r?\n/u);
  const lastLine = lines.at(-1);
  if (lastLine !== undefined && isPotentialCodexHostDirectiveStart(lastLine)) {
    lines.pop();
  }
  return collapseExcessBlankLines(lines.join("\n"));
}

function isPotentialCodexHostDirectiveStart(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("::")) {
    return false;
  }

  const fragment = trimmed.slice(2).split(/[{\s]/u)[0] ?? "";
  if (!fragment) {
    return true;
  }
  return Array.from(CODEX_HOST_DIRECTIVE_NAMES).some((name) => name.startsWith(fragment) || fragment.startsWith(name));
}
