// Terminal QR code display.
//
// Renders a QR code as scannable Unicode art in the terminal.
// Uses uqr (zero-dep, ~30KB) for encoding, renderUnicodeCompact for
// crisp half-block output (two pixel rows per terminal line).

import { renderUnicodeCompact } from "uqr";
import type { QRPayload } from "../security/index.ts";

/**
 * Render a QR payload as a scannable terminal QR code.
 *
 * The QR encodes the JSON-stringified payload so the phone camera
 * can scan it and get: relay URL, room ID, and bridge public key.
 */
export function renderQRCode(payload: QRPayload): string {
  const data = JSON.stringify(payload);

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
