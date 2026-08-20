import type { DiscoveredTranscript } from "./types.js";

function watcherKey(source: string, path: string): string {
  return `${source}:${path}`;
}

export function transcriptPathKey(transcript: DiscoveredTranscript): string {
  return watcherKey(transcript.source, transcript.transcriptPath);
}

/**
 * One tail registry row per harness session; path-only transcripts stay path-keyed.
 * Cursor process-monitor logs share one app sessionId across many rotating files.
 */
export function sessionRegistryKey(transcript: DiscoveredTranscript): string {
  if (transcript.source === "cursor") {
    return transcriptPathKey(transcript);
  }
  const sessionId = transcript.sessionId?.trim();
  if (sessionId) return `${transcript.source}:${sessionId}`;
  return transcriptPathKey(transcript);
}