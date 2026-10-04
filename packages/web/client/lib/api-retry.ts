import { friendlyApiError, isOfflineApiError } from "./api-errors.ts";

/** A failed startup read stays pending while its bounded recovery is in flight. */
export async function readWithRetry<T>(
  label: string,
  read: () => Promise<T>,
  trace: (message: string) => void,
  options: { retries?: number; sleep?: (ms: number) => Promise<void>; active?: () => boolean } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    if (options.active && !options.active()) throw new Error("Request superseded");
    trace(`${label}: requesting${attempt ? ` (retry ${attempt}/${retries})` : ""}`);
    try {
      const value = await read();
      trace(`${label}: received`);
      return value;
    } catch (cause) {
      const message = friendlyApiError(cause);
      const retryable = isOfflineApiError(message) || /\b50[234]\b|unavailable|starting|timed? out/i.test(message);
      if (!retryable || attempt >= retries) {
        trace(`${label}: ${message}`);
        throw cause;
      }
      trace(`${label}: no response yet; retrying`);
      await sleep(500 * (attempt + 1));
    }
  }
}
