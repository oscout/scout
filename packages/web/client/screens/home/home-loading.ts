import type { ConnectionNotice } from "../../components/ConnectionState.tsx";
import { isOfflineApiError } from "../../lib/api-errors.ts";

export { readWithRetry as loadHomeSource } from "../../lib/api-retry.ts";

export function homeLoadNotice(error: string): ConnectionNotice {
  return {
    kind: "error",
    title: isOfflineApiError(error) ? "Can’t reach Scout" : "Couldn’t load Home",
    detail: isOfflineApiError(error)
      ? "Scout may still be starting or may be stopped. Open Scout on the host computer, then try again."
      : "Scout couldn’t return your activity. Try again in a moment.",
    diagnostics: error,
  };
}
