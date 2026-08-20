import { api } from "./api.ts";

export type SessionCompactionResponse = {
  ok: boolean;
  delivered: boolean;
  method?: "codex-app-server" | "tmux-slash-command";
  command?: string;
  error?: string;
};

export async function requestSessionCompaction(input: {
  harness?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  tmuxSessionName?: string | null;
  agentId?: string | null;
}): Promise<SessionCompactionResponse> {
  return api<SessionCompactionResponse>("/api/session-control/compact", {
    method: "POST",
    body: JSON.stringify(input),
  });
}