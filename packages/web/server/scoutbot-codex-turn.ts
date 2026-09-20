import { randomUUID } from "node:crypto";
import { CodexAppServerClient, CodexAppServerRequesterTimeoutError, type CodexAppServerSessionOptions } from "@openscout/agent-sessions/local";
import type { ScoutbotCodexAssistantInvocation } from "./scoutbot-assistant.ts";

type TurnClient = Pick<CodexAppServerClient, "invoke" | "shutdown">;

/** One process per self-contained turn, never the shared long-lived agent cache.
 * Retiring it on every exit bounds chat/archive/brief/recap process lifetime.
 * Shutdown resets only runtime thread bindings/catalog state, not transcripts.
 */
export async function runScoutbotCodexTurn(
  input: ScoutbotCodexAssistantInvocation,
  optionsFor: (id: string, signal: AbortSignal, onDelta: (delta: string) => void) => CodexAppServerSessionOptions,
  createClient: (options: CodexAppServerSessionOptions) => TurnClient = (options) => new CodexAppServerClient(options),
): Promise<{ output: string; threadId: string }> {
  input.signal?.throwIfAborted();
  const owner = new AbortController();
  let open = true;
  const client = createClient(optionsFor(`${input.sessionId}-${randomUUID()}`, owner.signal, (delta) => {
    if (open && !owner.signal.aborted) input.onDelta?.(delta);
  }));
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    rejectAbort(new DOMException("Scoutbot request was cancelled.", "AbortError"));
    owner.abort();
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timeoutMs = input.timeoutMs ?? 60_000;
  const timer = setTimeout(() => {
    rejectAbort(new CodexAppServerRequesterTimeoutError({ label: "Scoutbot", timeoutMs }));
    owner.abort();
  }, timeoutMs);
  try {
    if (input.signal?.aborted) cancel();
    return await Promise.race([aborted, client.invoke(input.prompt, timeoutMs)]);
  } finally {
    open = false;
    owner.abort();
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    // Await cleanup before allowing fallback or another reply. Failure must be
    // visible, never silently leave an agent running after apparent success.
    try {
      await client.shutdown({ resetThread: true, reason: "Scoutbot turn retired" });
    } catch (error) {
      throw Object.assign(new Error(`Scoutbot agent cleanup failed: ${error instanceof Error ? error.message : String(error)}`), {
        code: "SCOUTBOT_AGENT_CLEANUP_FAILED",
      });
    }
  }
}
