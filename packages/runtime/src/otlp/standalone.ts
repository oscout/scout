import { otlpBaseUrl, otlpPaths, resolveOtlpPort } from "./config.js";
import { startOtlpReceiver } from "./receiver.js";

export function parseOtlpArguments(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const [command = "status", ...rest] = args;
  if (!["serve", "status", "tail"].includes(command)) throw new Error("Expected OTLP serve, status or tail");
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const value = rest[i + 1];
    if (!["--port", "--database", "--limit"].includes(key) || value === undefined || value.startsWith("--") || values.has(key)) {
      throw new Error("Invalid OTLP argument");
    }
    values.set(key, value);
  }
  const port = resolveOtlpPort(values.get("--port") ?? env.OPENSCOUT_OTLP_PORT);
  const databasePath = values.get("--database");
  if (command === "serve" && !databasePath) throw new Error("OTLP serve requires --database <path>");
  if (command !== "serve" && databasePath !== undefined) throw new Error("--database is only valid for serve");
  if (command !== "tail" && values.has("--limit")) throw new Error("--limit is only valid for tail");
  const rawLimit = values.get("--limit") ?? "100";
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500) throw new Error("OTLP tail limit must be 1..500");
  return { command, port, databasePath, limit: Number(rawLimit) };
}

export async function mainOtlp(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("otel serve --database <path> [--port n]\notel status [--port n]\notel tail [--port n] [--limit 1..500]");
    return;
  }
  const options = parseOtlpArguments(args);
  if (options.command === "serve") {
    const receiver = await startOtlpReceiver({ databasePath: options.databasePath!, port: options.port });
    console.log(`Scout OTLP inspection receiver listening at ${receiver.url}`);
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void receiver.close().then(resolve, reject);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const url = new URL(options.command === "status" ? otlpPaths.health : otlpPaths.observations, otlpBaseUrl(options.port));
  if (options.command === "tail") url.searchParams.set("limit", String(options.limit));
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`OTLP inspection failed (${response.status})`);
  const value: unknown = await response.json();
  if (options.command === "tail" && Array.isArray(value)) {
    for (const record of value) console.log(JSON.stringify(record));
  } else console.log(JSON.stringify(value, null, 2));
}
