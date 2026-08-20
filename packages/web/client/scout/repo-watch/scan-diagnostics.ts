export type ScanDiagnostic = {
  message: string;
  examples: string[];
  rawCount: number;
};

const MISSING_REPO_WATCH_PATH_PATTERN = /^Skipped missing repo-watch path:\s*(.+)$/i;
const MAX_MISSING_PATH_EXAMPLES = 4;

function missingPathGroupLabel(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "") || path.trim();
  if (!normalized) return "unknown paths";
  if (normalized === "~" || normalized.startsWith("~/")) return "~/*";
  if (!normalized.startsWith("/")) {
    const [head] = normalized.split(/[\\/]/).filter(Boolean);
    return head ? `${head}/*` : normalized;
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] === "Users" && parts[1]) return `/Users/${parts[1]}/*`;
  if (parts[0] === "Volumes" && parts[1]) return `/Volumes/${parts[1]}/*`;
  if (parts.length >= 2) return `/${parts[0]}/${parts[1]}/*`;
  return `/${parts[0] ?? ""}`;
}

function missingPathDiagnostic(paths: string[], label: string): ScanDiagnostic {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 1) {
    return {
      message: `Skipped missing repo-watch path: ${uniquePaths[0]}`,
      examples: [],
      rawCount: 1,
    };
  }

  const examples = uniquePaths.slice(0, MAX_MISSING_PATH_EXAMPLES);
  const remaining = uniquePaths.length - examples.length;
  if (remaining > 0) {
    examples.push(`+${remaining} more`);
  }

  return {
    message: `Skipped ${uniquePaths.length} missing repo-watch paths under ${label}. These look like stale broker hints.`,
    examples,
    rawCount: uniquePaths.length,
  };
}

function flushMissingPathDiagnostics(
  paths: string[],
  diagnostics: ScanDiagnostic[],
): void {
  if (paths.length === 0) return;

  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const label = missingPathGroupLabel(path);
    const group = groups.get(label);
    if (group) {
      group.push(path);
    } else {
      groups.set(label, [path]);
    }
  }

  for (const [label, groupedPaths] of groups) {
    diagnostics.push(missingPathDiagnostic(groupedPaths, label));
  }
  paths.length = 0;
}

export function summarizeScanDiagnostics(warnings: readonly string[]): ScanDiagnostic[] {
  const diagnostics: ScanDiagnostic[] = [];
  const missingPaths: string[] = [];

  for (const warning of warnings) {
    const missingPath = MISSING_REPO_WATCH_PATH_PATTERN.exec(warning);
    if (missingPath) {
      missingPaths.push(missingPath[1].trim());
      continue;
    }

    flushMissingPathDiagnostics(missingPaths, diagnostics);
    diagnostics.push({
      message: warning,
      examples: [],
      rawCount: 1,
    });
  }

  flushMissingPathDiagnostics(missingPaths, diagnostics);
  return diagnostics;
}
