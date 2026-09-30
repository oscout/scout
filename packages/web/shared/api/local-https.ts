// GET /api/local-https and POST /api/local-https/trust. Whether this Mac
// trusts the local edge's certificate authority, which is what lets the
// https door (and so the microphone) work on a named host.
export type LocalHttpsState = {
  status: "trusted" | "installed" | "untrusted" | "unavailable" | "skipped" | "error";
  trusted: boolean;
  detail: string;
  /** The https address of the page asking, or null on a loopback page. */
  secureOrigin: string | null;
  /** True when this page is on this Mac and the password dialog can open here. */
  canTrustHere: boolean;
  /** What to run on the Mac instead, when not trusted. */
  command: string | null;
};
