import { runStatuslineCommand } from "../../../apps/desktop/src/cli/commands/statusline.ts";

try {
  const args = process.argv[2] === "statusline"
    ? process.argv.slice(3)
    : process.argv.slice(2);
  const context: Parameters<typeof runStatuslineCommand>[0] = {
    env: process.env,
    output: {
      writeText(value: string) {
        process.stdout.write(`${value}\n`);
      },
    },
    stderr(message: string) {
      process.stderr.write(`${message}\n`);
    },
  } as Parameters<typeof runStatuslineCommand>[0];
  await runStatuslineCommand(context, args);
} catch {
  process.stdout.write("Scout | Claude status\n");
}
