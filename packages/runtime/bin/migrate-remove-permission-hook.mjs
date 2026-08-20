#!/usr/bin/env node
/**
 * migrate-remove-permission-hook
 *
 * Removes the deprecated Scout PreToolUse permission-routing hook from
 * Claude Code project settings. The hook was installed by an older version
 * of the Scout control plane and looks like:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "*",
 *           "hooks": [
 *             { "type": "command", "command": "node '.../claude-permission-hook.mjs'" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * The reliable signature is any inner hook whose `command` references
 * `claude-permission-hook.mjs` (or `.js`). All other hooks, permissions,
 * and settings keys are preserved.
 *
 * Default behavior is DRY-RUN. Pass --apply to actually modify files.
 * A `.bak` sibling is written before any modification.
 *
 * Usage:
 *   node migrate-remove-permission-hook.mjs [paths...] [--root DIR] [--apply] [--max-depth N] [--quiet]
 *
 *   paths      Explicit `.claude/settings.local.json` paths or directories
 *              containing one. Directories are searched recursively up to
 *              --max-depth (default 5) for `.claude/settings.local.json`
 *              and `.claude/settings.json`.
 *   --root     Convenience: same as passing a single directory.
 *   --apply    Write changes (otherwise dry-run).
 *   --max-depth Limit recursion depth when scanning a directory (default 5).
 *   --quiet    Suppress per-file "no change" lines.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const HOOK_SIGNATURE = "claude-permission-hook";

/**
 * Parse CLI args.
 */
function parseArgs(argv) {
  const args = { paths: [], apply: false, maxDepth: 5, quiet: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--max-depth") args.maxDepth = Number(argv[++i] ?? args.maxDepth);
    else if (a.startsWith("--max-depth=")) args.maxDepth = Number(a.split("=")[1]);
    else if (a === "--root") args.root = argv[++i] ?? null;
    else if (a.startsWith("--root=")) args.root = a.split("=")[1];
    else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else args.paths.push(a);
  }
  if (args.root) args.paths.push(args.root);
  if (args.paths.length === 0) args.paths.push(process.cwd());
  return args;
}

function printHelp() {
  const help = [
    "Usage: migrate-remove-permission-hook [paths...] [--root DIR] [--apply] [--max-depth N] [--quiet]",
    "",
    "Removes deprecated Scout PreToolUse hooks (claude-permission-hook.mjs)",
    "from .claude/settings.local.json (and .claude/settings.json) files.",
    "",
    "Default is dry-run. Pass --apply to write changes (a .bak sibling is",
    "written before modifying each file).",
  ].join("\n");
  console.log(help);
}

/**
 * Return true if `cmd` references the deprecated permission hook.
 */
function commandIsDeprecatedHook(cmd) {
  return typeof cmd === "string" && cmd.includes(HOOK_SIGNATURE);
}

/**
 * Pure transform: returns { next, removedEntries, removedInner } given a parsed
 * settings object. Does not mutate `settings`.
 */
function stripPermissionHook(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { next: settings, removedEntries: 0, removedInner: 0, changed: false };
  }
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") {
    return { next: settings, removedEntries: 0, removedInner: 0, changed: false };
  }
  const preToolUse = hooks.PreToolUse;
  if (!Array.isArray(preToolUse)) {
    return { next: settings, removedEntries: 0, removedInner: 0, changed: false };
  }

  let removedInner = 0;
  let removedEntries = 0;

  const nextPre = [];
  for (const entry of preToolUse) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
      nextPre.push(entry);
      continue;
    }
    const filteredInner = entry.hooks.filter((h) => {
      const drop = h && typeof h === "object" && commandIsDeprecatedHook(h.command);
      if (drop) removedInner += 1;
      return !drop;
    });
    if (filteredInner.length === 0) {
      // Drop the whole matcher entry.
      removedEntries += 1;
      continue;
    }
    if (filteredInner.length !== entry.hooks.length) {
      nextPre.push({ ...entry, hooks: filteredInner });
    } else {
      nextPre.push(entry);
    }
  }

  if (removedInner === 0 && removedEntries === 0) {
    return { next: settings, removedEntries: 0, removedInner: 0, changed: false };
  }

  const nextHooks = { ...hooks };
  if (nextPre.length === 0) {
    delete nextHooks.PreToolUse;
  } else {
    nextHooks.PreToolUse = nextPre;
  }

  const next = { ...settings };
  if (Object.keys(nextHooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = nextHooks;
  }

  return { next, removedEntries, removedInner, changed: true };
}

/**
 * Detect the file's trailing newline so we can preserve it.
 */
function preserveTrailingNewline(original, serialized) {
  return original.endsWith("\n") ? `${serialized}\n` : serialized;
}

async function processFile(filePath, { apply, quiet }) {
  let original;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { filePath, status: "missing" };
    return { filePath, status: "error", error: err.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(original);
  } catch (err) {
    return { filePath, status: "invalid-json", error: err.message };
  }

  const { next, removedEntries, removedInner, changed } = stripPermissionHook(parsed);
  if (!changed) {
    if (!quiet) console.log(`[ok] ${filePath} (no deprecated hook)`);
    return { filePath, status: "unchanged" };
  }

  const serialized = preserveTrailingNewline(original, JSON.stringify(next, null, 2));

  console.log(`[hit] ${filePath}`);
  console.log(`      removed ${removedInner} inner hook(s), ${removedEntries} matcher entry(ies)`);
  printUnifiedDiff(original, serialized);

  if (!apply) {
    return { filePath, status: "would-change", removedInner, removedEntries };
  }

  const backup = `${filePath}.bak`;
  await fs.writeFile(backup, original, "utf8");
  await fs.writeFile(filePath, serialized, "utf8");
  console.log(`      wrote backup: ${backup}`);
  console.log(`      updated:      ${filePath}`);
  return { filePath, status: "applied", removedInner, removedEntries };
}

/**
 * Minimal line-diff. Avoids any dependency; not a strict unified diff.
 */
function printUnifiedDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const aSet = new Map();
  for (const line of a) aSet.set(line, (aSet.get(line) ?? 0) + 1);
  const bSet = new Map();
  for (const line of b) bSet.set(line, (bSet.get(line) ?? 0) + 1);
  const removed = [];
  for (const [line, count] of aSet) {
    const keep = bSet.get(line) ?? 0;
    const diff = count - keep;
    for (let i = 0; i < diff; i++) removed.push(line);
  }
  const added = [];
  for (const [line, count] of bSet) {
    const keep = aSet.get(line) ?? 0;
    const diff = count - keep;
    for (let i = 0; i < diff; i++) added.push(line);
  }
  for (const line of removed) console.log(`      - ${line}`);
  for (const line of added) console.log(`      + ${line}`);
}

/**
 * Walk a directory looking for .claude/settings.local.json and
 * .claude/settings.json (project scope). Skips node_modules, .git, dist,
 * build, out, .next, .turbo, .cache by default.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  ".pnpm-store",
]);

async function findSettingsFiles(root, maxDepth) {
  const found = new Set();
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === ".claude") {
        for (const f of ["settings.local.json", "settings.json"]) {
          const candidate = path.join(full, f);
          try {
            const stat = await fs.stat(candidate);
            if (stat.isFile()) found.add(candidate);
          } catch {
            // missing - skip
          }
        }
        continue;
      }
      await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return [...found].sort();
}

async function resolveTargets(inputs, maxDepth) {
  const targets = new Set();
  for (const raw of inputs) {
    const p = path.resolve(raw);
    let stat;
    try {
      stat = await fs.stat(p);
    } catch {
      console.warn(`[warn] path not found: ${p}`);
      continue;
    }
    if (stat.isFile()) {
      targets.add(p);
    } else if (stat.isDirectory()) {
      // If the dir itself is a .claude dir, scan it directly.
      if (path.basename(p) === ".claude") {
        for (const f of ["settings.local.json", "settings.json"]) {
          const c = path.join(p, f);
          try {
            if ((await fs.stat(c)).isFile()) targets.add(c);
          } catch {
            // skip
          }
        }
      } else {
        for (const f of await findSettingsFiles(p, maxDepth)) targets.add(f);
      }
    }
  }
  return [...targets].sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const targets = await resolveTargets(args.paths, args.maxDepth);
  if (targets.length === 0) {
    console.log("No .claude/settings(.local).json files found.");
    return;
  }

  console.log(
    `Scanning ${targets.length} file(s) for deprecated Scout PreToolUse hook ` +
      `(${args.apply ? "APPLY" : "dry-run"}):`,
  );
  console.log("");

  let wouldChange = 0;
  let applied = 0;
  let errors = 0;
  for (const t of targets) {
    const result = await processFile(t, { apply: args.apply, quiet: args.quiet });
    if (result.status === "would-change") wouldChange += 1;
    else if (result.status === "applied") applied += 1;
    else if (result.status === "error" || result.status === "invalid-json") {
      console.error(`[err] ${result.filePath}: ${result.error}`);
      errors += 1;
    }
  }

  console.log("");
  console.log("Summary:");
  console.log(`  scanned:       ${targets.length}`);
  if (args.apply) console.log(`  modified:      ${applied}`);
  else console.log(`  would modify:  ${wouldChange}`);
  if (errors) console.log(`  errors:        ${errors}`);
  if (!args.apply && wouldChange > 0) {
    console.log("");
    console.log("Re-run with --apply to write changes (a .bak sibling will be created).");
  }
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
