import { preflightLifecycle } from "../../../../packages/cli/bin/lifecycle-preflight.mjs";

// Service imports can initialize local state, so load them only after help and
// lifecycle validation have completed, including when running from source.
try {
  const help = preflightLifecycle(process.argv.slice(2));
  if (help !== null) console.log(help);
  else await import("./main-dispatch.ts");
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
