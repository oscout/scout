export declare const SCOUT_PAIRING_DEEP_LINK_SCHEME: "scout";
export declare const SCOUT_PAIRING_DEEP_LINK_PATH: "pair";
export type PairingDeepLinks = {
  default: string | null;
  lan: string | null;
  tailnet: string | null;
};
export declare function pairingDeepLink(qrValue: string | null | undefined): string | null;
export declare function pairingDeepLinks(qrValue: string | null | undefined): PairingDeepLinks;
