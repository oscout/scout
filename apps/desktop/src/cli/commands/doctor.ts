import { DOCTOR_CHECK_NAMES, runDoctorCheck, renderDoctorCheck, renderDoctorAssessment } from "../doctor-checks.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseDoctorCommandOptions } from "../options.ts";
import {
  loadScoutDoctorReport,
} from "../../core/setup/service.ts";
import { resolveScoutWorkspaceRoot } from "../../shared/paths.ts";
import { scoutTuiNeedsDownload, SCOUT_TUI_INSTALL_OFFER } from "./tui.ts";
import {
  loadNativeScoutdDoctorReport,
  renderNativeScoutdDoctorSection,
} from "../scoutd.ts";
import {
  formatScoutDoctorStreamedProjectEntry,
  renderScoutDoctorStreamingLead,
  renderScoutDoctorTailAfterStream,
} from "../../ui/terminal/setup.ts";

const DOCTOR_JSON_SCHEMA = "scout.doctor.v1" as const;

function writeDoctorJsonLine(context: ScoutCommandContext, payload: Record<string, unknown>): void {
  context.output.writeText(`${JSON.stringify({ schema: DOCTOR_JSON_SCHEMA, ...payload })}\n`);
}

export function renderDoctorCommandHelp(): string {
  return [
    "Usage: scout doctor [--detail | --json] [--context-root <path>] [--fix [--yes]]",
    "", "Default: concise checks as they finish, with a 6-second deadline per check.",
    "FAIL means observed impairment; ? means inconclusive, not confirmed failure.",
    "--detail  Full legacy report, including project inventory and internal paths.",
    "--json    Compatible scout.doctor.v1 NDJSON stream; ends with phase complete.",
    "Detail and v1 JSON retain the legacy full-scan wait behavior.",
    "--fix     Explicit native repair request; uses the full legacy report.",
    "--yes     Non-interactive confirmation for --fix.",
    "--help    Show this help without checking or maintaining services.",
  ].join("\n");
}

export async function runDoctorCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(renderDoctorCommandHelp());
    return;
  }
  const options = parseDoctorCommandOptions(args, defaultScoutContextDirectory(context));
  const outputJson = context.output.mode === "json" || options.json;
  if (!outputJson && !options.detail && !options.fix) {
    context.output.writeText("Scout doctor — checking local readiness (6s per check)…");
    const checks = await Promise.all(DOCTOR_CHECK_NAMES.map(async name => {
      const check = await runDoctorCheck(name, { cwd: options.currentDirectory, env: context.env });
      context.output.writeText(renderDoctorCheck(check));
      return check;
    }));
    context.output.writeText(renderDoctorAssessment(checks));
    // An offer only; doctor never downloads it.
    if (scoutTuiNeedsDownload({ env: context.env, cwd: options.currentDirectory })) {
      context.output.writeText(SCOUT_TUI_INSTALL_OFFER);
    }
    return;
  }
  const repoRoot = (() => {
    try {
      return resolveScoutWorkspaceRoot({
        currentDirectory: options.currentDirectory,
        env: context.env,
      });
    } catch {
      return options.currentDirectory;
    }
  })();

  if (!outputJson) {
    context.output.writeText(
      renderScoutDoctorStreamingLead({
        repoRoot,
        currentDirectory: options.currentDirectory,
      }),
    );
    const report = await loadScoutDoctorReport({
      currentDirectory: options.currentDirectory,
      repoRoot,
      env: context.env,
      onProjectInventoryEntry: (entry) => {
        context.output.writeText(formatScoutDoctorStreamedProjectEntry(entry));
      },
      onProjectInventoryError: (error) => {
        context.output.writeText(`  ! ${error.relativePath}: ${error.message}\n`);
      },
    });
    const native = await loadNativeScoutdDoctorReport({
      fix: options.fix,
      yes: options.yes,
      env: context.env,
    });
    if (report.setup.projectInventory.length === 0) {
      context.output.writeText("  No projects discovered yet.\n");
    }
    context.output.writeText(renderScoutDoctorTailAfterStream(report));
    const nativeSection = renderNativeScoutdDoctorSection(native);
    if (nativeSection) {
      context.output.writeText(nativeSection);
    }
    return;
  }

  writeDoctorJsonLine(context, {
    phase: "start",
    repoRoot,
    currentDirectory: options.currentDirectory,
  });

  const report = await loadScoutDoctorReport({
    currentDirectory: options.currentDirectory,
    repoRoot,
    env: context.env,
    onProjectInventoryEntry: (entry) => {
      writeDoctorJsonLine(context, { phase: "project", project: entry });
    },
    onProjectInventoryError: (error) => {
      writeDoctorJsonLine(context, { phase: "project_error", error });
    },
  });

  const native = await loadNativeScoutdDoctorReport({
    fix: options.fix,
    yes: options.yes,
    env: context.env,
  });
  writeDoctorJsonLine(context, { phase: "native", nativeDaemon: native });
  writeDoctorJsonLine(context, {
    phase: "complete",
    report: {
      ...report,
      nativeDaemon: native,
    },
  });
}
