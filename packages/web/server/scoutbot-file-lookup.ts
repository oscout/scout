import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * Finds files by loose name for a spoken turn. A voice request names a file
 * the way a person would ("the live voice lifecycle doc"), and a view-file
 * action needs its absolute path, which the snapshot does not carry.
 *
 * The listing is `git ls-files` (tracked plus untracked, ignores applied), cached
 * briefly so repeated lookups in one conversation don't re-walk the tree.
 */

const LISTING_TTL_MS = 60_000;
const MAX_MATCHES = 8;
const STOPWORDS = new Set([
  "a", "an", "and", "doc", "docs", "document", "file", "for", "in", "me", "my", "of", "on",
  "open", "our", "please", "show", "the", "this", "to", "up",
]);

export type ScoutbotFileLookup = (query: string) => Promise<string[]>;

export function createScoutbotFileLookup(root: string): ScoutbotFileLookup {
  let listing: { at: number; files: Promise<string[]> } | null = null;

  const listFiles = () => {
    if (listing && Date.now() - listing.at < LISTING_TTL_MS) return listing.files;
    const files = gitListFiles(root).catch(() => [] as string[]);
    listing = { at: Date.now(), files };
    return files;
  };

  return async (query) => rankScoutbotFileMatches(query, await listFiles()).map((file) => join(root, file));
}

export function rankScoutbotFileMatches(query: string, files: readonly string[]): string[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const needed = Math.max(1, Math.ceil(terms.length / 2));
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let matched = 0;
    let score = 0;
    for (const term of terms) {
      if (base.includes(term)) {
        matched += 1;
        score += 2;
      } else if (lower.includes(term)) {
        matched += 1;
        score += 1;
      }
    }
    if (matched >= needed) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
  return scored.slice(0, MAX_MATCHES).map((entry) => entry.file);
}

function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

function gitListFiles(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.split("\n").filter(Boolean));
      },
    );
  });
}
