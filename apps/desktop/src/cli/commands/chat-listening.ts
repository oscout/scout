import { OPENSCOUT_PORTS } from "../../../../../packages/runtime/src/local-config.ts";
import type { ScoutCommandContext } from "../context.ts";

/** One request, no poll/watch loop and no service bootstrap. Explicit --agent
 * selects a durable identity; cwd and harness session never choose custody. */
export async function chatListeningRequest(context: Pick<ScoutCommandContext, "env">, command: string, body: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  let origin: URL;
  try { origin = new URL(context.env.OPENSCOUT_LISTENING_URL || `http://127.0.0.1:${context.env.OPENSCOUT_LISTENING_PORT ?? OPENSCOUT_PORTS.roomListening}`); }
  catch { throw new Error("Chat listening requires a valid local listening service URL."); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)) throw new Error("Chat listening requires a loopback local listening service URL.");
  let response: Response;
  try {
    if (origin.hostname === "localhost") origin.hostname = "127.0.0.1";
    response = await fetcher(new URL(`/v1/chat-listening/${command}`, origin), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error("Local listening service request failed. No service was started; retry the same operation."); }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof result?.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? result.error : "request_failed";
    throw new Error(`Chat listening: ${code} (${response.status}).`);
  }
  return result;
}
