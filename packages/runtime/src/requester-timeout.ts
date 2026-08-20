export class RequesterWaitTimeoutError extends Error {
  readonly code = "REQUESTER_WAIT_TIMEOUT";
  readonly timeoutMs: number;
  readonly label: string;

  constructor(input: { label: string; timeoutMs: number }) {
    super(`Timed out after ${input.timeoutMs}ms waiting for ${input.label}.`);
    this.name = "RequesterWaitTimeoutError";
    this.label = input.label;
    this.timeoutMs = input.timeoutMs;
  }
}

export function isRequesterWaitTimeoutError(error: unknown): error is RequesterWaitTimeoutError {
  return error instanceof RequesterWaitTimeoutError
    || (
      Boolean(error)
      && typeof error === "object"
      && (error as { code?: unknown }).code === "REQUESTER_WAIT_TIMEOUT"
      && typeof (error as { timeoutMs?: unknown }).timeoutMs === "number"
    );
}
