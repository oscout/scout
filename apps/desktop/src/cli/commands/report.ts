import { submitDiagnosticReport, formatDiagnosticReceipt } from "@openscout/runtime/diagnostic-report";
import { SCOUT_APP_VERSION } from "../../shared/product.ts";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export async function runReportCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  await run(context, args, true);
}
export async function runFeedbackCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  await run(context, args, false);
}
async function run(context: ScoutCommandContext, args: string[], diagnostics: boolean) {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    context.output.writeText('Usage: scout report [note] [--local-only]\n       scout feedback <note> [--diagnostics] [--local-only]\n\nReports include redacted, bounded service traces and data health; feedback sends only your note unless --diagnostics is set.\nA private local copy is saved before upload. Collection works without the broker.');
    return;
  }
  const unknown = args.find((arg) => arg.startsWith("--") && !["--local-only", "--diagnostics"].includes(arg));
  if (unknown) throw new ScoutCliError(`Unknown report option: ${unknown}`);
  const message = args.filter((arg) => !["--local-only", "--diagnostics"].includes(arg)).join(" ").trim();
  if (!diagnostics && !message) throw new ScoutCliError("Feedback requires a note.");
  const result = await submitDiagnosticReport({ message, diagnostics: diagnostics || args.includes("--diagnostics"), localOnly: args.includes("--local-only"), version: SCOUT_APP_VERSION });
  context.output.writeValue(result, formatDiagnosticReceipt);
}
