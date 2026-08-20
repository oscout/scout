import type { Readable } from "node:stream";

type ClosableServer = {
  close(): Promise<void>;
};

type ClosableTransport = {
  close(): Promise<void>;
  onclose?: () => void;
};

/**
 * Keep an imported stdio command alive until its transport actually closes.
 *
 * The MCP SDK's stdio server transport listens for data, but does not close
 * itself when stdin reaches EOF. Owning that lifecycle here lets the CLI await
 * the real session instead of spinning on Node/Bun's `beforeExit` event.
 */
export async function waitForStdioServerClosure(options: {
  server: ClosableServer;
  transport: ClosableTransport;
  stdin?: Readable;
  processSignals?: NodeJS.Process;
}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const processSignals = options.processSignals ?? process;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let transportClosing: Promise<void> | null = null;
    let serverClosing: Promise<void> | null = null;
    const previousOnClose = options.transport.onclose;

    const cleanup = () => {
      stdin.off("end", requestTransportClose);
      stdin.off("close", requestTransportClose);
      processSignals.off("SIGINT", requestServerClose);
      processSignals.off("SIGTERM", requestServerClose);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const settleClose = (operation: () => Promise<void>) => {
      return operation().then(
        () => finish(),
        (error) => finish(error),
      );
    };
    function requestTransportClose() {
      transportClosing ??= settleClose(() => options.transport.close());
    }
    function requestServerClose() {
      serverClosing ??= settleClose(() => options.server.close());
    }

    options.transport.onclose = () => {
      previousOnClose?.();
      finish();
    };
    stdin.once("end", requestTransportClose);
    stdin.once("close", requestTransportClose);
    processSignals.once("SIGINT", requestServerClose);
    processSignals.once("SIGTERM", requestServerClose);

    if (stdin.readableEnded || stdin.destroyed) {
      requestTransportClose();
    }
  });
}
