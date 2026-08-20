import {
  runCursorSdkPersistentTurnSpike,
  runCursorSdkTransportSpike,
  writeSpikeJson,
} from "./sdk-transport-node.mjs";

function failFromProcessError(error, input) {
  const cause = error?.cause;
  writeSpikeJson({
    mode: input.payload?.mode ?? "cursor_sdk_local",
    ok: false,
    durationMs: 0,
    authSource: input.payload?.authSource ?? "none",
    errorCode: cause?.code || error?.code || error?.name || "sdk_process_error",
    errorMessage: cause?.message || error?.message || String(error),
    notes: ["captured_from_process_handler"],
  });
  process.exit(1);
}

const input = JSON.parse(process.argv[2] ?? "{}");

process.on("unhandledRejection", (error) => {
  failFromProcessError(error, input);
});

process.on("uncaughtException", (error) => {
  failFromProcessError(error, input);
});

try {
  if (input.kind === "persistent") {
    const report = await runCursorSdkPersistentTurnSpike(input.payload);
    writeSpikeJson(report);
    process.exit(0);
  }

  const result = await runCursorSdkTransportSpike(input.payload);
  writeSpikeJson(result);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeSpikeJson({
    mode: input.payload?.mode ?? "cursor_sdk_local",
    ok: false,
    durationMs: 0,
    authSource: input.payload?.authSource ?? "none",
    errorCode: "sdk_child_crash",
    errorMessage: message,
  });
  process.exit(1);
}
