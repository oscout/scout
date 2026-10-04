export declare const SCOUT_PAIRING_DEEP_LINK_SCHEME: "scout";
export declare const SCOUT_PAIRING_DEEP_LINK_PATH: "pair";
export declare const SCOUT_PAIRING_WEB_LINK_BASE: "https://openscout.app/pair";
export type PairingDeepLinks = {
  default: string | null;
  lan: string | null;
  tailnet: string | null;
};
export declare function pairingDeepLink(qrValue: string | null | undefined): string | null;
export declare function pairingDeepLinks(qrValue: string | null | undefined): PairingDeepLinks;
export declare function pairingWebLink(qrValue: string | null | undefined): string | null;
