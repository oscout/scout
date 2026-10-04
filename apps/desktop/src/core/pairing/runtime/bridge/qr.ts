// Terminal QR code display.
//
// Renders a QR code as scannable Unicode art in the terminal.
// Uses uqr (zero-dep, ~30KB) for encoding, renderUnicodeCompact for
// crisp half-block output (two pixel rows per terminal line).

import { renderUnicodeCompact } from "uqr";
import type { QRPayload } from "../security/index.ts";

// Mirrors pairingWebLink in packages/web/shared/pairing-link.js. The iOS app
// claims this path as a universal link, so the phone's Camera opens Scout;
// without the app the page offers the install. The app's own scanner reads
// the same link. The payload rides in the fragment, which browsers never
// send, so it stays out of server logs.
const PAIRING_WEB_LINK_BASE = "https://openscout.app/pair";

export function pairingWebLink(payload: QRPayload): string {
  return `${PAIRING_WEB_LINK_BASE}#payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

/**
 * Render a QR payload as a scannable terminal QR code.
 *
 * The QR encodes the pairing web link, which carries the JSON payload
 * (relay URL, room ID, bridge public key) in its `#payload=` fragment.
 */
export function renderQRCode(payload: QRPayload): string {
  const data = pairingWebLink(payload);

  // renderUnicodeCompact uses ▀/▄/█/space to pack two rows per line —
  // this produces a smaller, more scannable code in the terminal.
  const qr = renderUnicodeCompact(data, {
    border: 2,
    ecc: "M", // 15% error correction — good balance of size vs resilience
  });

  return qr;
}

/**
 * Print the QR code with context info to stdout.
 */
export function printQRCode(payload: QRPayload): void {
  const qr = renderQRCode(payload);
  const expiresIn = Math.max(0, Math.round((payload.expiresAt - Date.now()) / 1000));

  console.log("");
  console.log("  Scan this QR code with the Pairing app to pair:");
  console.log("");
  // Indent each line for visual centering
  for (const line of qr.split("\n")) {
    console.log(`  ${line}`);
  }
  console.log("");
  console.log(`  relay  : ${payload.relay}`);
  console.log(`  room   : ${payload.room}`);
  console.log(`  key    : ${payload.publicKey.slice(0, 16)}...`);
  console.log(`  expires: ${expiresIn}s`);
  console.log("");
}
