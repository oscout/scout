import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseDoctorCommandOptions } from "../options.ts";
import {
  loadScoutDoctorReport,
} from "../../core/setup/service.ts";
import { resolveScoutWorkspaceRoot } from "../../shared/paths.ts";
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

export async function runDoctorCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseDoctorCommandOptions(args, defaultScoutContextDirectory(context));
  const outputJson = context.output.mode === "json" || options.json;
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
