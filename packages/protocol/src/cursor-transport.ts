/**
 * Local Cursor harness transport modes under evaluation.
 * See docs/eng/sco-047-cursor-transport-spike.md.
 */
export const CURSOR_LOCAL_TRANSPORT_MODES = [
  "cursor_cli_text",
  "cursor_cli_stream_json",
  "cursor_sdk_local",
  "cursor_sdk_local_no_key",
] as const;

export type CursorLocalTransportMode = typeof CURSOR_LOCAL_TRANSPORT_MODES[number];

export type CursorTransportAuthSource =
  | "none"
  | "env"
  | "cursor_api_key_file"
  | "cli_flag"
  | "sdk_option";

export type CursorTransportSpikeResult = {
  mode: CursorLocalTransportMode;
  ok: boolean;
  durationMs: number;
  authSource: CursorTransportAuthSource;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  outputText?: string;
  eventCount?: number;
  errorCode?: string;
  errorMessage?: string;
  notes?: string[];
};
