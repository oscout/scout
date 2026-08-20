#!/usr/bin/env bun
import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";
import { createInterface } from "node:readline";

import { claudeCodeEventInventoryAdapter } from "../claude-code/event-inventory.js";
import { codexEventInventoryAdapter } from "../codex/event-inventory.js";
import {
  isRecord,
  type AdapterEventExtraction,
  type EventInventoryAdapter,
  type SemanticEventKind,
} from "../event-inventory.js";
import { grokAcpEventInventoryAdapter } from "../grok-acp/event-inventory.js";

interface CliOptions {
  adapters: Set<string> | null;
  format: "table" | "json";
  maxFiles: number | null;
  maxLines: number | null;
  paths: string[];
}

interface InventoryRow {
  adapter: string;
  sourceKind: string;
  semanticType: SemanticEventKind;
  rawType: string;
  rawSubtype: string;
  detail: string;
  count: number;
  examples: string[];
}

interface ScanStats {
  filesVisited: number;
  filesParsed: number;
  recordsParsed: number;
  recordsSkipped: number;
  recordsMatched: number;
}

const adapters = [
  codexEventInventoryAdapter,
  claudeCodeEventInventoryAdapter,
  grokAcpEventInventoryAdapter,
];

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const paths: string[] = [];
  let format: CliOptions["format"] = "table";
  let adapterFilter: Set<string> | null = null;
  let maxFiles: number | null = null;
  let maxLines: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--table") {
      format = "table";
      continue;
    }
    if (arg.startsWith("--format=")) {
      const next = arg.slice("--format=".length);
      if (next !== "json" && next !== "table") {
        throw new Error("--format must be table or json.");
      }
      format = next;
      continue;
    }
    if (arg === "--adapter" || arg === "--adapters") {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} expects a comma-separated adapter list.`);
      adapterFilter = new Set(next.split(",").map((value) => value.trim()).filter(Boolean));
      continue;
    }
    if (arg.startsWith("--adapter=") || arg.startsWith("--adapters=")) {
      const next = arg.slice(arg.indexOf("=") + 1);
      adapterFilter = new Set(next.split(",").map((value) => value.trim()).filter(Boolean));
      continue;
    }
    if (arg === "--max-files") {
      const next = argv[++index];
      if (!next) throw new Error("--max-files expects a value.");
      maxFiles = parsePositiveInteger(next, "--max-files");
      continue;
    }
    if (arg.startsWith("--max-files=")) {
      maxFiles = parsePositiveInteger(arg.slice("--max-files=".length), "--max-files");
      continue;
    }
    if (arg === "--max-lines") {
      const next = argv[++index];
      if (!next) throw new Error("--max-lines expects a value.");
      maxLines = parsePositiveInteger(next, "--max-lines");
      continue;
    }
    if (arg.startsWith("--max-lines=")) {
      maxLines = parsePositiveInteger(arg.slice("--max-lines=".length), "--max-lines");
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    paths.push(arg);
  }

  return {
    adapters: adapterFilter,
    format,
    maxFiles,
    maxLines,
    paths,
  };
}

function printHelp(): void {
  console.log(`Usage: bun packages/agent-sessions/src/adapters/tools/extract-event-types.ts [options] [paths...]

Scans local harness log/transcript files and reports raw event types mapped to
OpenScout semantic trace buckets. If no paths are provided, the script scans
known file-backed roots for the selected adapters.

Options:
  --adapter codex,claude-code,grok-acp  Limit adapters
  --format table|json                   Output format (default: table)
  --json                                Alias for --format=json
  --max-files N                         Stop after N candidate files
  --max-lines N                         Read at most N lines per file
  -h, --help                            Show this help

Notes:
  - This intentionally scans file-backed logs/transcripts only.
  - It does not read or mutate ~/.codex/logs_2.sqlite.
`);
}

function selectedAdapters(options: CliOptions): EventInventoryAdapter[] {
  if (!options.adapters) {
    return adapters;
  }
  const selected = adapters.filter((adapter) => options.adapters?.has(adapter.id));
  const missing = [...options.adapters].filter((id) => !adapters.some((adapter) => adapter.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown adapter(s): ${missing.join(", ")}. Known: ${adapters.map((adapter) => adapter.id).join(", ")}`);
  }
  return selected;
}

function defaultRootsFor(adaptersToScan: EventInventoryAdapter[]): string[] {
  const home = homedir();
  return [
    ...new Set(adaptersToScan.flatMap((adapter) => adapter.defaultRoots(home))),
  ].filter((path) => existsSync(path));
}

function isCandidateFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jsonl") return true;
  if (ext === ".log") return true;
  return filePath.endsWith("stdout.log") || filePath.endsWith("stderr.log");
}

async function collectFiles(paths: string[], maxFiles: number | null): Promise<string[]> {
  const files: string[] = [];
  const queue = [...paths];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      if (isCandidateFile(current)) {
        files.push(current);
        if (maxFiles !== null && files.length >= maxFiles) break;
      }
      continue;
    }

    if (!stat.isDirectory()) continue;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(child);
      } else if (entry.isFile() && isCandidateFile(child)) {
        files.push(child);
        if (maxFiles !== null && files.length >= maxFiles) break;
      }
    }

    if (maxFiles !== null && files.length >= maxFiles) break;
  }

  return files;
}

function adaptersForRecord(
  adaptersToScan: EventInventoryAdapter[],
  filePath: string,
): EventInventoryAdapter[] {
  const matching = adaptersToScan.filter((adapter) => adapter.matchesFile(filePath));
  return matching.length > 0 ? matching : adaptersToScan;
}

function rowKey(adapter: EventInventoryAdapter, extraction: AdapterEventExtraction): string {
  return [
    adapter.id,
    extraction.sourceKind,
    extraction.semanticType,
    extraction.rawType,
    extraction.rawSubtype ?? "",
    extraction.detail ?? "",
  ].join("\t");
}

function addExtraction(
  rows: Map<string, InventoryRow>,
  adapter: EventInventoryAdapter,
  extraction: AdapterEventExtraction,
  example: string,
): void {
  const key = rowKey(adapter, extraction);
  const existing = rows.get(key);
  if (existing) {
    existing.count += 1;
    if (existing.examples.length < 3 && !existing.examples.includes(example)) {
      existing.examples.push(example);
    }
    return;
  }

  rows.set(key, {
    adapter: adapter.id,
    sourceKind: extraction.sourceKind,
    semanticType: extraction.semanticType,
    rawType: extraction.rawType,
    rawSubtype: extraction.rawSubtype ?? "",
    detail: extraction.detail ?? "",
    count: 1,
    examples: [example],
  });
}

async function scanFile(
  filePath: string,
  adaptersToScan: EventInventoryAdapter[],
  rows: Map<string, InventoryRow>,
  stats: ScanStats,
  options: CliOptions,
): Promise<void> {
  stats.filesVisited += 1;
  const fileAdapters = adaptersForRecord(adaptersToScan, filePath);
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let parsedAny = false;

  for await (const line of lines) {
    lineNumber += 1;
    if (options.maxLines !== null && lineNumber > options.maxLines) {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      stats.recordsSkipped += 1;
      continue;
    }
    if (!isRecord(record)) {
      stats.recordsSkipped += 1;
      continue;
    }

    parsedAny = true;
    stats.recordsParsed += 1;
    const example = `${relative(process.cwd(), filePath) || filePath}:${lineNumber}`;
    let matched = false;
    for (const adapter of fileAdapters) {
      const extracted = adapter.extract(record, { filePath, lineNumber });
      for (const entry of extracted) {
        addExtraction(rows, adapter, entry, example);
        matched = true;
      }
    }
    if (matched) {
      stats.recordsMatched += 1;
    }
  }

  if (parsedAny) {
    stats.filesParsed += 1;
  }
}

function compareRows(left: InventoryRow, right: InventoryRow): number {
  return left.adapter.localeCompare(right.adapter)
    || left.semanticType.localeCompare(right.semanticType)
    || right.count - left.count
    || left.sourceKind.localeCompare(right.sourceKind)
    || left.rawType.localeCompare(right.rawType)
    || left.detail.localeCompare(right.detail);
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function printTable(rows: InventoryRow[], stats: ScanStats): void {
  console.log(`files: ${stats.filesParsed}/${stats.filesVisited} parsed  records: ${stats.recordsParsed} parsed, ${stats.recordsMatched} matched, ${stats.recordsSkipped} skipped\n`);

  const headers = ["adapter", "semantic", "source", "raw", "detail", "count", "example"];
  const widths = [12, 15, 18, 34, 22, 8, 46];
  console.log(headers.map((header, index) => pad(header, widths[index]!)).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    const raw = row.rawSubtype ? `${row.rawType}:${row.rawSubtype}` : row.rawType;
    const values = [
      row.adapter,
      row.semanticType,
      row.sourceKind,
      raw,
      row.detail,
      String(row.count),
      row.examples[0] ?? "",
    ];
    console.log(values.map((value, index) => pad(truncate(value, widths[index]!), widths[index]!)).join("  "));
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const adaptersToScan = selectedAdapters(options);
  const roots = options.paths.length > 0 ? options.paths : defaultRootsFor(adaptersToScan);
  if (roots.length === 0) {
    throw new Error("No input paths found. Pass one or more JSONL/log paths or check that default harness roots exist.");
  }

  const files = await collectFiles(roots, options.maxFiles);
  const rows = new Map<string, InventoryRow>();
  const stats: ScanStats = {
    filesVisited: 0,
    filesParsed: 0,
    recordsParsed: 0,
    recordsSkipped: 0,
    recordsMatched: 0,
  };

  for (const file of files) {
    await scanFile(file, adaptersToScan, rows, stats, options);
  }

  const sortedRows = [...rows.values()].sort(compareRows);
  if (options.format === "json") {
    console.log(JSON.stringify({
      stats,
      rows: sortedRows,
    }, null, 2));
    return;
  }
  printTable(sortedRows, stats);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
