/* Pure helpers for the code browser project picker: flatten repo-watch
   projects into selectable worktree options, score free-text matches, and
   order recents ahead of the rest when the query is empty. */

export type CodeProjectOption = {
  /** Worktree absolute path — the selection key. */
  root: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  worktreeName: string;
  branchLabel: string;
  dirtyLabel: string;
  /** True when this is the primary (index-0) worktree for the project. */
  isPrimary: boolean;
  changedFiles: number;
};

export type CodeProjectSource = {
  id: string;
  name: string;
  worktrees: Array<{
    id: string;
    path: string;
    name: string;
    branch: { detached: boolean; name: string | null };
    status: { clean: boolean; changedFiles: number };
  }>;
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function pathLeaf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function branchLabel(worktree: CodeProjectSource["worktrees"][number]): string {
  return worktree.branch.detached ? "detached" : worktree.branch.name ?? "no branch";
}

function dirtyLabel(worktree: CodeProjectSource["worktrees"][number]): string {
  if (worktree.status.clean) return "";
  return `${worktree.status.changedFiles} changed`;
}

export function flattenProjectOptions(projects: CodeProjectSource[]): CodeProjectOption[] {
  const options: CodeProjectOption[] = [];
  for (const project of projects) {
    for (const [index, worktree] of project.worktrees.entries()) {
      options.push({
        root: worktree.path,
        projectId: project.id,
        projectName: project.name,
        projectSlug: slugify(project.name) || slugify(pathLeaf(project.name)),
        worktreeName: worktree.name,
        branchLabel: branchLabel(worktree),
        dirtyLabel: dirtyLabel(worktree),
        isPrimary: index === 0,
        changedFiles: worktree.status.changedFiles,
      });
    }
  }
  return options;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s/_-]+/g, " ").trim();
}

/** Score a free-text match against name · path · branch · worktree. Higher is better; -1 is no match. */
export function scoreProjectOption(option: CodeProjectOption, rawQuery: string, recentRank = 0): number {
  const query = normalize(rawQuery);
  if (!query) return recentRank;

  const terms = query.split(" ").filter(Boolean);
  const name = normalize(option.projectName);
  const path = normalize(option.root);
  const branch = normalize(option.branchLabel);
  const worktree = normalize(option.worktreeName);
  const haystack = `${name} ${path} ${branch} ${worktree} ${option.projectSlug}`;

  if (!terms.every((term) => haystack.includes(term))) return -1;

  let result = recentRank / 100;
  if (name === query || option.projectSlug === query.replace(/\s+/g, "-")) result += 120;
  else if (name.startsWith(query) || option.projectSlug.startsWith(query.replace(/\s+/g, "-"))) result += 80;
  else if (name.includes(query)) result += 48;
  if (branch.startsWith(query) || branch.includes(query)) result += 34;
  if (worktree.includes(query)) result += 24;
  if (path.includes(query)) result += 20;
  result += terms.reduce((total, term) => total + (name.startsWith(term) ? 12 : 0), 0);
  return result;
}

/**
 * Filter + rank options. Empty query → recent-first (then name), capped.
 * Non-empty query → scored matches only.
 */
export function filterProjectOptions(
  options: CodeProjectOption[],
  query: string,
  recentRoots: readonly string[],
  limit = 12,
): CodeProjectOption[] {
  const recentRank = new Map(recentRoots.map((root, index) => [root, recentRoots.length - index]));
  const scored = options
    .map((option) => ({
      option,
      score: scoreProjectOption(option, query, recentRank.get(option.root) ?? 0),
    }))
    .filter((entry) => entry.score >= 0);

  if (!query.trim()) {
    scored.sort((a, b) => {
      const aRecent = recentRank.get(a.option.root) ?? -1;
      const bRecent = recentRank.get(b.option.root) ?? -1;
      if (aRecent !== bRecent) return bRecent - aRecent;
      return a.option.projectName.localeCompare(b.option.projectName)
        || a.option.branchLabel.localeCompare(b.option.branchLabel);
    });
  } else {
    scored.sort((a, b) => b.score - a.score
      || a.option.projectName.localeCompare(b.option.projectName));
  }

  return scored.slice(0, limit).map((entry) => entry.option);
}

/** Compact chip / trigger label: `openscout` or `openscout · feature-x` for non-primary worktrees. */
export function optionChipLabel(option: CodeProjectOption): string {
  if (option.isPrimary) return option.projectName;
  return `${option.projectName} · ${option.branchLabel}`;
}

/** Summary line under the name: branch · dirty count. */
export function optionDetailLabel(option: CodeProjectOption): string {
  return option.dirtyLabel
    ? `${option.branchLabel} · ${option.dirtyLabel}`
    : option.branchLabel;
}

/** Shorten an absolute path for the head path strip. */
export function shortRootPath(path: string): string {
  // Browser has no HOME; approximate the common ~/dev style from the path leaf parents.
  const home = typeof window !== "undefined"
    ? (window as Window & { __OPEN_SCOUT_HOME?: string }).__OPEN_SCOUT_HOME
    : undefined;
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  if (path.startsWith("/Users/")) {
    const rest = path.slice("/Users/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) return `~${rest.slice(slash)}`;
  }
  if (path.startsWith("/home/")) {
    const rest = path.slice("/home/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) return `~${rest.slice(slash)}`;
  }
  return path;
}
