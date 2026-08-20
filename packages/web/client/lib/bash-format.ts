/**
 * bash-format — the single source of truth for how a shell command is read in
 * the lane trace. Pure logic (no React, no DOM) so it is easy to test and tweak
 * centrally; the presentational `LaneBashLine` component renders what this
 * returns.
 *
 * A command is read in three tiers so the eye lands on what actually ran:
 *   prog — the real program (ink)            e.g. `bun`, `rg`, `tsc`
 *   arg  — that program's arguments (muted)  e.g. `bin/app.ts restart`
 *   dim  — everything else (dim): a leading env/wrapper prefix, operators
 *          (`&&` `|` `;`), redirects (`2>&1`) and piped helper commands.
 * A leading `cd <dir>` is pulled out separately into a powerline directory
 * segment, and home paths are tilde-shortened.
 */

export type BashTier = "prog" | "arg" | "dim" | "dir";

export type BashSpan = {
  text: string;
  tier: BashTier;
  /** the program is a recognised command (see KNOWN_COMMANDS) */
  known: boolean;
  /** this arg is a flag (`-p`, `--watch`) — rendered a touch quieter */
  flag: boolean;
};

export type BashLine = {
  /** tilde-shortened directory to show as a powerline segment, or null */
  dir: string | null;
  /** the tiered command */
  spans: BashSpan[];
};

/**
 * How the leading `cd <dir> &&` of a command is presented.
 *
 * Default is "off": a `cd` is the command *navigating*, so dressing it up as a
 * powerline prompt (which implies "where you already are") is misleading —
 * doubly so since codex prefixes nearly every command with a boilerplate `cd`
 * back to the project root. So by default it just reads inline as dim plumbing.
 * The powerline look stays available as an explicit opt-in.
 *
 *   "off"    — never lift it; the `cd …` stays inline as dim plumbing. (default)
 *   "always" — always lift a leading cd into a powerline segment.
 *   "smart"  — a segment only when the dir DIFFERS from the session cwd (a real
 *              directory change); a redundant `cd` back to the cwd is dropped.
 *              (needs `cwd` passed in.)
 */
export type PowerlineMode = "off" | "always" | "smart";

export type BashFormatOptions = {
  /** the session's working directory, for the "smart" comparison */
  cwd?: string | null;
  powerline?: PowerlineMode;
};

/** Default everywhere unless a caller overrides it. */
export const DEFAULT_POWERLINE_MODE: PowerlineMode = "off";

/** Normalise a path for comparison: tilde-shorten + drop a trailing slash. */
function normalizePath(path: string): string {
  return tildeShortenPath(path).replace(/\/+$/u, "");
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

/** shell control operators — always plumbing */
const BASH_OPERATORS = new Set(["&&", "||", "|", "|&", ";", "&"]);

/** builtins whose own arguments are plumbing too (their whole segment recedes).
 *  `cd` is handled separately — its directory gets a thoughtful `dir` tier so the
 *  destination reads, rather than vanishing into the plumbing. */
const BASH_PREFIX_BUILTINS = new Set(["export", "set", "source", ".", "unset", "alias"]);

/** wrappers that precede the REAL command — dim them, the program still follows */
const BASH_WRAPPERS = new Set([
  "sudo", "doas", "time", "env", "xargs", "nice", "nohup", "command", "builtin",
  "exec", "watch", "stdbuf", "setsid", "timeout", "caffeinate",
]);

/** The commands agents actually reach for — POSIX/coreutils + the modern dev
 *  toolbelt. Recognising the program is the hook for confident treatment (and
 *  per-command niceties later). Grouped only for editing legibility. */
export const KNOWN_COMMANDS = new Set([
  // search / nav / text
  "rg", "grep", "ag", "ack", "fd", "find", "awk", "sed", "cut", "tr", "sort", "uniq",
  "wc", "head", "tail", "cat", "bat", "less", "more", "tee", "nl", "rev", "column",
  "ls", "eza", "tree", "fzf", "jq", "yq", "xsv", "diff", "patch", "comm", "paste",
  // vcs
  "git", "gh", "hub", "glab",
  // js / runtimes / pkg
  "node", "deno", "bun", "npm", "pnpm", "yarn", "npx", "tsc", "tsx", "vite", "esbuild",
  "eslint", "prettier", "biome", "vitest", "jest", "mocha", "playwright",
  // python / ruby / go / rust / jvm
  "python", "python3", "pip", "pip3", "uv", "ruff", "ruby", "gem", "bundle", "rake",
  "go", "gofmt", "cargo", "rustc", "java", "javac", "gradle", "mvn", "dotnet",
  // swift / apple
  "swift", "swiftc", "xcodebuild", "xcrun", "simctl", "pod", "fastlane",
  // build / infra / net
  "make", "cmake", "ninja", "docker", "kubectl", "helm", "terraform", "ansible",
  "curl", "wget", "ssh", "scp", "rsync", "nc", "dig", "ping",
  // fs / proc / sys
  "cp", "mv", "rm", "mkdir", "touch", "ln", "chmod", "chown", "tar", "zip", "unzip",
  "gzip", "ps", "kill", "pkill", "lsof", "df", "du", "top", "htop", "which", "echo",
  "printf", "date", "sleep", "open", "pbcopy", "pbpaste", "say", "afplay", "defaults",
]);

const isBashRedirect = (t: string) => /^\d*[<>]{1,2}&?\d*$/u.test(t) || t === "&>" || t === "&>>";
const isBashEnvAssignment = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(t);
const isBashFlag = (t: string) => /^-{1,2}[A-Za-z0-9]/u.test(t);
/** the program's recognisable name (drop a path: ./node_modules/.bin/tsc → tsc) */
const bashBaseName = (t: string) => t.replace(/^.*\//u, "");

/** Replace the current user's home prefix with `~` so paths read short. */
export function tildeShortenPath(text: string): string {
  return text.replace(/\/Users\/[^/\s]+/gu, "~");
}

/** Split a command into emphasis-tiered tokens (see module docs). */
export function bashDisplaySpans(command: string): BashSpan[] {
  const tokens = tildeShortenPath(command).trim().split(/\s+/u).filter(Boolean);
  const spans: BashSpan[] = [];
  let expectProgram = true; // at the start, and after every operator
  let foundPrimary = false; // the first real command — the one we spotlight
  let primaryArgs = false; // whether following args belong to the primary command
  let cdDirNext = false; // the next token is a cd destination (gets the dir tier)
  for (const token of tokens) {
    if (BASH_OPERATORS.has(token) || isBashRedirect(token)) {
      spans.push({ text: token, tier: "dim", known: false, flag: false });
      expectProgram = true;
      primaryArgs = false;
      cdDirNext = false;
      continue;
    }
    if (cdDirNext) {
      // the directory a cd moves into — thoughtful, reads as a destination
      spans.push({ text: token, tier: "dir", known: false, flag: false });
      cdDirNext = false;
      continue;
    }
    if (expectProgram) {
      // env assignments + wrappers dim out but the program still follows them
      if (isBashEnvAssignment(token) || BASH_WRAPPERS.has(token)) {
        spans.push({ text: token, tier: "dim", known: false, flag: false });
        continue;
      }
      if (token === "cd") {
        spans.push({ text: token, tier: "dim", known: false, flag: false });
        expectProgram = false;
        primaryArgs = false;
        cdDirNext = true;
        continue;
      }
      if (BASH_PREFIX_BUILTINS.has(token)) {
        spans.push({ text: token, tier: "dim", known: false, flag: false });
        expectProgram = false;
        primaryArgs = false;
        continue;
      }
      spans.push({
        text: token,
        tier: foundPrimary ? "dim" : "prog",
        known: KNOWN_COMMANDS.has(bashBaseName(token)),
        flag: false,
      });
      primaryArgs = !foundPrimary;
      foundPrimary = true;
      expectProgram = false;
      continue;
    }
    spans.push({
      text: token,
      tier: primaryArgs ? "arg" : "dim",
      known: false,
      flag: primaryArgs && isBashFlag(token),
    });
  }
  return spans;
}

/** Pull a leading `cd <dir> [&&]` off a command so the directory can ride its own
 *  powerline segment and the real command leads. Returns the (tilde-shortened)
 *  dir and the remaining command. */
export function splitCdPrefix(command: string): { dir: string | null; rest: string } {
  const match = command.match(/^\s*cd\s+(\S+)\s*(?:&&\s*(.*))?$/u);
  if (!match) return { dir: null, rest: command };
  return { dir: tildeShortenPath(match[1]), rest: (match[2] ?? "").trim() };
}

/** The one entry point: a command string → the full structured line to render.
 *  `opts.powerline` + `opts.cwd` decide how a leading `cd` is presented. */
export function formatBashLine(command: string, opts: BashFormatOptions = {}): BashLine {
  const mode = opts.powerline ?? DEFAULT_POWERLINE_MODE;
  const { dir, rest } = splitCdPrefix(command);

  // No leading cd, or we never lift it → tier the whole command as-is (an "off"
  // cd then reads inline as dim plumbing).
  if (dir === null || mode === "off") {
    return { dir: null, spans: bashDisplaySpans(command) };
  }

  // Smart: a cd back to the session cwd is redundant boilerplate — drop it and
  // show just the command. Only a cd to a DIFFERENT directory earns a segment.
  if (mode === "smart" && samePath(dir, opts.cwd)) {
    return { dir: null, spans: rest ? bashDisplaySpans(rest) : [] };
  }

  return { dir, spans: rest ? bashDisplaySpans(rest) : [] };
}
