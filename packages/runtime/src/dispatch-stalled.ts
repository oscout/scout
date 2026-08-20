export class DispatchStalledError extends Error {
  readonly code = "DISPATCH_STALLED";
  readonly sessionName: string;
  readonly paneTail: string;
  readonly retries: number;

  constructor(input: { sessionName: string; paneTail: string; retries: number }) {
    super(
      `tmux dispatch for session ${input.sessionName} left the prompt in the composer after submit + ${input.retries} retr${input.retries === 1 ? "y" : "ies"}.`,
    );
    this.name = "DispatchStalledError";
    this.sessionName = input.sessionName;
    this.paneTail = input.paneTail;
    this.retries = input.retries;
  }
}

export function isDispatchStalledError(error: unknown): error is DispatchStalledError {
  return error instanceof DispatchStalledError
    || (
      Boolean(error)
      && typeof error === "object"
      && (error as { code?: unknown }).code === "DISPATCH_STALLED"
      && typeof (error as { sessionName?: unknown }).sessionName === "string"
    );
}
