import type { RuntimeHttpServerLike } from "./portable-types.js";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export function isAddressInUse(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "EADDRINUSE",
  );
}

export async function prepareBrokerSocketPath(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) {
      throw new Error(`broker socket path exists but is not a socket: ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function listenTcp(
  serverInstance: RuntimeHttpServerLike,
  options: { host: string; port: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: unknown) => {
      serverInstance.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      serverInstance.off("error", handleError);
      resolve();
    };

    serverInstance.once("error", handleError);
    serverInstance.once("listening", handleListening);
    serverInstance.listen(options.port, options.host);
  });
}

export async function listenUnixSocket(
  serverInstance: RuntimeHttpServerLike,
  socketPath: string,
): Promise<void> {
  await prepareBrokerSocketPath(socketPath);
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: unknown) => {
      serverInstance.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      serverInstance.off("error", handleError);
      resolve();
    };

    serverInstance.once("error", handleError);
    serverInstance.once("listening", handleListening);
    serverInstance.listen(socketPath);
  });
}

export function forceCloseServer(serverInstance: RuntimeHttpServerLike): void {
  const forceCloseable = serverInstance as RuntimeHttpServerLike & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };
  forceCloseable.closeAllConnections?.();
  forceCloseable.closeIdleConnections?.();
}

export function closeServer(serverInstance: RuntimeHttpServerLike, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    if (!serverInstance.listening) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      forceCloseServer(serverInstance);
      finish();
    }, timeoutMs);
    timeout.unref();
    serverInstance.close(() => finish());
  });
}
