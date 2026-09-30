import { captureTmuxPane } from "@openscout/runtime/system-probes";
import { TmuxPanePeekRequest, TmuxPanePeekCapture } from "./web-server-options.ts";

export const TMUX_PEEK_CAPTURE_MIN_LINES = 60;

export const TMUX_PEEK_MAX_BYTES = 48 * 1024;

export async function defaultCaptureTmuxPane(request: TmuxPanePeekRequest): Promise<TmuxPanePeekCapture | null> {
  const body = await captureTmuxPane(request.paneTarget, {
    start: `-${Math.max(request.lines, TMUX_PEEK_CAPTURE_MIN_LINES)}`,
    end: "-",
    joinWrapped: true,
    maxBytes: TMUX_PEEK_MAX_BYTES,
  });
  return body === null ? null : { body };
}
