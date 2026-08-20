#!/usr/bin/env bun

async function runClaudeStatuslineFastPath(): Promise<boolean> {
  const args = process.argv.slice(2);
  if (args[0] !== "statusline" || args[1] !== "claude") {
    return false;
  }

  try {
    const { runStatuslineCommand } = await import("../src/cli/commands/statusline.ts");
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
    await runStatuslineCommand(context, args.slice(1));
  } catch {
    process.stdout.write("Scout | Claude status\n");
  }

  return true;
}

if (!(await runClaudeStatuslineFastPath())) {
  await import("../src/cli/main.ts");
}
