import type { ConnectionNotice } from "../../components/ConnectionState.tsx";
import { isOfflineApiError } from "../../lib/api-errors.ts";

export const SCOUT_CONNECTION_TITLE = "Can’t connect to Scout";
export const SCOUT_CONNECTION_HELP = "Scout may be stopped or still starting. Start Scout on the host computer, then try again. If it’s already running, check your connection to that computer.";

export function terminalRelayTraceError(error: string | null): string | null {
  if (error === "Relay service is not running") return "Terminal service health check did not respond";
  if (error === "Could not connect to relay") return "Terminal service connection failed";
  return error;
}

export function terminalLoadNotice(state: "loading" | "ready" | "failed", error?: string | null): ConnectionNotice | null {
  if (state === "ready") return null;
  if (state === "loading") return { kind: "loading", title: "Loading your terminals", detail: "Waiting for Scout to report the sessions on this host." };
  return {
    kind: "error",
    title: isOfflineApiError(error) ? SCOUT_CONNECTION_TITLE : "Couldn’t load your terminals",
    detail: isOfflineApiError(error) ? SCOUT_CONNECTION_HELP : "Scout couldn’t return the terminal list. Try again in a moment. Previously shown sessions may be out of date.",
    diagnostics: error,
  };
}

export function terminalRelayNotice(input: {
  status: "disconnected" | "connecting" | "connected" | "error";
  error: string | null;
  exitCode: number | null;
  apiOffline: boolean;
  attempted: boolean;
}): ConnectionNotice | null {
  if (input.status === "connected") return null;
  if (input.status === "connecting" || (input.status === "disconnected" && !input.attempted)) {
    return { kind: "loading", title: "Connecting to your terminal", detail: "Waiting for Scout’s terminal service to open the connection." };
  }
  if (input.exitCode === 0) return { kind: "disconnected", title: "Terminal session ended", detail: "The process finished successfully. Connect again to open a terminal." };
  if (input.apiOffline) return { kind: "error", title: SCOUT_CONNECTION_TITLE, detail: SCOUT_CONNECTION_HELP, diagnostics: input.error };
  if (input.error === "Relay service is not running" || input.error === "Could not connect to relay") {
    return { kind: "error", title: "Terminal connection unavailable", detail: "Scout’s terminal service didn’t respond. Try again in a moment. If this continues, check Scout’s services on the host computer.", diagnostics: input.error };
  }
  if (input.status === "disconnected") return { kind: "disconnected", title: "Terminal disconnected", detail: "The connection closed. Reconnect to check whether your session is still available." };
  return { kind: "error", title: input.exitCode !== null ? "Terminal process stopped" : "Couldn’t open this terminal", detail: "Scout couldn’t complete the terminal connection. Review the details below, then try again.", diagnostics: [input.error, input.exitCode !== null ? `Exit code: ${input.exitCode}` : null].filter(Boolean).join("\n") };
}
