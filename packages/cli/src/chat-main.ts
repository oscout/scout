import { basename } from "node:path";
import { parseScoutArgv } from "../../../apps/desktop/src/cli/argv.ts";
import { createScoutCommandContext } from "../../../apps/desktop/src/cli/context.ts";
import { runChatCommand } from "../../../apps/desktop/src/cli/commands/chat.ts";

const standaloneAlias = basename(process.argv[1] ?? "") === "scout-chat";
const input = parseScoutArgv([...(standaloneAlias ? ["chat"] : []), ...process.argv.slice(2)]);
try {
  await runChatCommand(createScoutCommandContext({ outputMode: input.outputMode }), input.args, standaloneAlias ? "scout-chat" : "scout chat");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Chat command failed.");
  process.exitCode = 1;
}
