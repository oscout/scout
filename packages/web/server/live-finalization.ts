// The web server runs on Bun, whose WebSocket constructor accepts server
// headers. DOM lib types omit this server-only overload.
const ServerWebSocket = globalThis.WebSocket as unknown as {
  new(url: string, options: { headers: Record<string, string> }): WebSocket;
};
export function connectLiveControl(url: string, apiKey: string): WebSocket {
  return new ServerWebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

export type LiveFinalization = {
  state: "confirmed" | "unconfirmed";
  reason?: string;
  seconds?: number;
};

/** A separate authenticated control connection can end an abandoned browser
 * session. Only session.closed confirms final usage; a socket close does not. */
export async function finalizeLiveSession(sessionId: string, apiKey: string, options: {
  connect?: (url: string, key: string) => WebSocket;
  timeoutMs?: number;
} = {}): Promise<LiveFinalization> {
  return new Promise(resolve => {
    let socket: WebSocket | undefined;
    let done = false;
    const finish = (result: LiveFinalization) => {
      if (done) return; done = true; clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ state: "unconfirmed", reason: "control_timeout" }), options.timeoutMs ?? 5000);
    try {
      const url = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
      socket = options.connect ? options.connect(url, apiKey) : connectLiveControl(url, apiKey);
      socket.addEventListener("open", () => {
        if (!done) socket!.send(JSON.stringify({ type: "session.close", event_id: crypto.randomUUID() }));
      });
      socket.addEventListener("message", event => {
        try {
          const value = JSON.parse(String(event.data));
          if (value?.type === "session.closed") finish({ state: "confirmed", reason: typeof value.reason === "string" ? value.reason : undefined,
            seconds: typeof value.usage?.seconds === "number" && Number.isFinite(value.usage.seconds) ? value.usage.seconds : undefined });
        } catch {}
      });
      socket.addEventListener("error", () => finish({ state: "unconfirmed", reason: "control_error" }));
      socket.addEventListener("close", () => finish({ state: "unconfirmed", reason: "control_disconnected" }));
    } catch { finish({ state: "unconfirmed", reason: "control_unavailable" }); }
  });
}
