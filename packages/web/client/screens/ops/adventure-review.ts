import type { AdventureStop } from "./agent-adventures-model.ts";
import { adventurePlayback, adventureCommandText, adventureIsValidationCommand } from "./adventure-playback.ts";
export type AdventureReviewMode = "results" | "all" | "problems" | "continuous";
export function adventureReviewReason(stop: AdventureStop, mode: AdventureReviewMode): string | null {
  if (mode === "continuous") return null;
  const raw = stop.event.result?.exit_code ?? stop.event.result?.exitCode;
  const code = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : null;
  if (code !== null && code !== 0) return `Command needs attention · exit ${code}`;
  if (stop.kind === "stopped") return "Journey interrupted";
  if (stop.kind === "wait") return "Waiting for input";
  if (mode === "problems") return null;
  if (stop.kind === "end") return "Turn complete";
  if (mode === "all") return adventurePlayback(stop).checkpoint ? adventurePlayback(stop).label : null;
  const command = adventureCommandText(stop);
  return command && code !== null && adventureIsValidationCommand(command) ? "Validation result ready" : null;
}
