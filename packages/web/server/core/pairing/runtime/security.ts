import { loadTrustedPeers } from "./security/index";

export * from "./security/index";

export type PairingQrPayload = import("./security").QRPayload;

export { createQRPayload as createQrPayload } from "./security";

export function trustedPeerCount() {
  return loadTrustedPeers().size;
}
