import {
  resolveScoutTerminalRelayHealthUrl,
  resolveScoutTerminalRelayUrl,
} from "../../lib/runtime-config.ts";
import { useTerminalRelay, TerminalRelay } from "hudsonkit/terminal";

export function ScoutTerminal() {
  const relayUrl = resolveScoutTerminalRelayUrl();
  const healthUrl = resolveScoutTerminalRelayHealthUrl();
  const relay = useTerminalRelay({
    url: relayUrl,
    healthUrl,
    autoConnect: true,
    sessionKey: "scout-terminal",
  });

  return (
    <div style={{ height: "100%", background: "#0d0d0d", overflow: "hidden" }}>
      <TerminalRelay
        relay={relay}
        fontSize={13}
        configItems={[
          { label: "ws", value: relayUrl },
          { label: "health", value: healthUrl },
        ]}
      />
    </div>
  );
}
