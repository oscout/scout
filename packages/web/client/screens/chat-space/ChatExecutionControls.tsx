import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChatExecution, ChatInterrupt } from "./chat-api.ts";

type ExecutionAccess = {
  scope: string;
  load: (flightId: string) => Promise<ChatExecution>;
  interrupt: (flightId: string, input: ChatInterrupt) => Promise<unknown>;
};
export const ChatExecutionAccess = createContext<ExecutionAccess | null>(null);

/** After a stop, look for the observed turn to leave `streaming`. */
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_POLL_LIMIT = 10;

type StopPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "stopping"; turnId: string }
  | { kind: "stopped" }
  | { kind: "unconfirmed" }
  | { kind: "nothing" }
  | { kind: "error"; text: string };

/**
 * One Stop button for a running request. It reads the recorded execution on
 * click, interrupts only that observed turn, then watches for the turn to end.
 * The bridge revalidates the turn before forwarding, and a turn is never
 * submitted twice from here.
 */
export function ChatStopControl({ flightId }: { flightId: string }) {
  const access = useContext(ChatExecutionAccess);
  return access ? <StopControl key={`${access.scope}:${flightId}`} flightId={flightId} access={access} /> : null;
}

function StopControl({ flightId, access }: { flightId: string; access: ExecutionAccess }) {
  const [phase, setPhase] = useState<StopPhase>({ kind: "idle" });
  const submitted = useRef(new Set<string>());
  const pending = useRef(false);

  useEffect(() => {
    if (phase.kind !== "stopping") return;
    let polls = 0;
    const timer = setInterval(() => {
      if (++polls > CONFIRM_POLL_LIMIT) { clearInterval(timer); setPhase({ kind: "unconfirmed" }); return; }
      void access.load(flightId).then(next => {
        if (next.turnId !== phase.turnId || next.status !== "streaming") { clearInterval(timer); setPhase({ kind: "stopped" }); }
      }).catch(() => {});
    }, CONFIRM_POLL_MS);
    return () => clearInterval(timer);
  }, [phase, access, flightId]);

  const stop = async () => {
    if (pending.current) return;
    pending.current = true; setPhase({ kind: "checking" });
    try {
      const data = await access.load(flightId);
      if (!data.available || !data.interruptible || !data.sessionId || !data.turnId) { setPhase({ kind: "nothing" }); return; }
      const key = JSON.stringify([data.sessionId, data.turnId]);
      if (submitted.current.has(key)) { setPhase({ kind: "stopping", turnId: data.turnId }); return; }
      submitted.current.add(key);
      try {
        await access.interrupt(flightId, { sessionId: data.sessionId, turnId: data.turnId });
        setPhase({ kind: "stopping", turnId: data.turnId });
      } catch {
        setPhase({ kind: "error", text: "The stop could not be confirmed. It will not be sent again for this turn; check the session." });
      }
    } catch {
      setPhase({ kind: "error", text: "Could not read the running session. Try again." });
    } finally { pending.current = false; }
  };

  const status = {
    idle: null,
    checking: null,
    stopping: "Stopping · waiting for the session…",
    stopped: "Stopped. The session ended this turn.",
    unconfirmed: "Stop sent. The session has not confirmed it yet.",
    nothing: "Nothing to stop right now. The agent is not mid-turn.",
    error: phase.kind === "error" ? phase.text : null,
  }[phase.kind];
  const showButton = phase.kind === "idle" || phase.kind === "checking" || phase.kind === "nothing" || phase.kind === "error";
  return <>
    {status ? <p className="chat-ask-trail" role={phase.kind === "error" ? "alert" : "status"}>{status}</p> : null}
    {showButton ? <button type="button" className="chat-ask-stop" disabled={phase.kind === "checking"} onClick={() => void stop()}>
      {phase.kind === "checking" ? "Stopping…" : "Stop"}
    </button> : null}
  </>;
}
