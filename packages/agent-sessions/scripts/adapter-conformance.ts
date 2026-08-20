#!/usr/bin/env bun
import { projectSessionDisplayState } from "../../runtime/src/session-display-projection.js";
import {
  formatConformanceReportText,
  runAdapterConformance,
} from "../src/conformance/runner.js";

function parseArgs(argv: string[]): { adapter: string | null; format: "text" | "json" } {
  let adapter: string | null = null;
  let format: "text" | "json" = "text";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--adapter") {
      adapter = argv[index + 1] ?? null;
      index += 1;
    } else if (arg?.startsWith("--adapter=")) {
      adapter = arg.slice("--adapter=".length);
    } else if (arg === "--format") {
      const value = argv[index + 1];
      if (value === "json" || value === "text") format = value;
      index += 1;
    } else if (arg?.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value === "json" || value === "text") format = value;
    }
  }
  return { adapter, format };
}

const { adapter, format } = parseArgs(process.argv.slice(2));
const report = await runAdapterConformance({
  adapterFilter: adapter,
  projectDisplayState: projectSessionDisplayState,
});

process.stdout.write(format === "json"
  ? `${JSON.stringify(report, null, 2)}\n`
  : formatConformanceReportText(report));

if (report.failed) process.exitCode = 1;
