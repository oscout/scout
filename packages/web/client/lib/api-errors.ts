export function friendlyApiError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return isNetworkApiError(message) ? "Scout server is unreachable" : message;
}

export function isOfflineApiError(message: string | null | undefined): boolean {
  return message === "Scout server is unreachable";
}

function isNetworkApiError(message: string): boolean {
  return /failed to fetch|fetch failed|networkerror|load failed|couldn'?t connect|could not connect|connection refused|econnrefused|server is unreachable/i.test(message);
}
