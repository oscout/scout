import { join } from "node:path";
import type { startOtlpReceiver } from "./receiver.js";

export async function startBrokerOtlpReceiver(
  controlHome: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: () => void = () => console.warn("[openscout-runtime] OTLP receiver unavailable; telemetry disabled"),
): Promise<Awaited<ReturnType<typeof startOtlpReceiver>> | undefined> {
  if (env.OPENSCOUT_OTLP_ENABLED !== "1") return undefined;
  try {
    const { startOtlpReceiver, resolveOtlpPort } = await import("./index.js");
    return await startOtlpReceiver({
      databasePath: join(controlHome, "otel-observations.sqlite"),
      port: resolveOtlpPort(env.OPENSCOUT_OTLP_PORT),
    });
  } catch { warn(); return undefined; }
}
