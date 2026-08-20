import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Scout's colour rule, enforced rather than remembered.
 *
 * Red means error, destructive, or blocked. Amber/yellow means warning or
 * operator attention. Everything else — identities, sender labels, routing
 * explanations, informational notices, categories, decoration, permission
 * confirmation, neutral status — uses the cool palette instead.
 *
 * The banned arc deliberately runs magenta → pink → red → orange → yellow,
 * not just red → yellow: a pink-red or magenta accent reads as a signal to
 * anyone scanning the screen, which is the thing the rule is protecting.
 *
 * This walks the chat surface's stylesheets, finds every colour in that arc,
 * and requires it to sit in a declaration that truthfully carries one of the
 * two meanings. A new warm colour anywhere else fails here, not in review. */

const STYLESHEETS = ["scout-chat.css", "messages-theme.css", "whatsapp-theme.css"];

/** Selectors that genuinely mean error, destructive, blocked, or attention. */
const SEMANTIC_SELECTORS = [
  /\.inline-error\b/,
  /\.send-error\b/,
  /\.technical-error\b/,
  /\.delivery-issue-mark\b/,
  /\.destructive\b/,
  /\[data-issue="(failed|unconfirmed)"\]/,
  // Deny, and Stop: refusing an action and interrupting a running turn.
  /\.approval-buttons button:first-child\b/,
  /\.tech-strip button\b/,
  // Host sync status, but only in its degraded and unreachable tones. The
  // healthy and connecting states must stay in the neutral treatment.
  /\.encryption-note\[data-tone="(warning|error)"\]/,
];

/** Properties allowed to hold a warm value regardless of selector: the danger
 * token definitions themselves, and the WhatsApp paper canvas, which is a
 * near-neutral surface rather than a signal. */
const SEMANTIC_PROPERTIES = [/^--danger/, /^--canvas$/];

type Declaration = { selector: string; property: string; value: string; line: number };

function stripComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

/** Brace-aware walk that keeps the full nesting path, so a rule inside an
 * `@media (prefers-color-scheme: dark)` block is attributed to both. */
function declarations(css: string): Declaration[] {
  const source = stripComments(css);
  const found: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  let line = 1;
  for (const character of source) {
    if (character === "\n") line += 1;
    if (character === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (character === "}") {
      flush();
      stack.pop();
    } else if (character === ";") {
      flush();
    } else {
      buffer += character;
    }
  }
  return found;

  function flush() {
    const text = buffer.trim();
    buffer = "";
    const split = text.indexOf(":");
    if (split <= 0) return;
    found.push({
      selector: stack.join(" « "),
      property: text.slice(0, split).trim(),
      value: text.slice(split + 1).trim(),
      line,
    });
  }
}

function channels(hex: string) {
  let body = hex.slice(1);
  if (body.length === 3) body = [...body].map((c) => c + c).join("");
  if (body.length === 8) body = body.slice(0, 6);
  if (body.length !== 6) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(body.slice(offset, offset + 2), 16));
}

/** Hue in the magenta→yellow signal arc, at a saturation and lightness where
 * it actually reads as a colour rather than as a tint of the surface. */
function warmHue(hex: string): number | null {
  const rgb = channels(hex);
  if (!rgb) return null;
  const [red, green, blue] = rgb.map((value) => value / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return null;
  const saturation = lightness > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  if (saturation < 0.18 || lightness < 0.06 || lightness > 0.93) return null;
  let hue: number;
  if (max === red) hue = ((green - blue) / (max - min) + (green < blue ? 6 : 0)) * 60;
  else if (max === green) hue = ((blue - red) / (max - min) + 2) * 60;
  else hue = ((red - green) / (max - min) + 4) * 60;
  return hue <= 65 || hue >= 285 ? Math.round(hue) : null;
}

function isSemantic(declaration: Declaration) {
  return SEMANTIC_PROPERTIES.some((pattern) => pattern.test(declaration.property))
    || SEMANTIC_SELECTORS.some((pattern) => pattern.test(declaration.selector));
}

function warmViolations(fileName: string) {
  const css = readFileSync(join(import.meta.dir, fileName), "utf8");
  return declarations(css).flatMap((declaration) => {
    if (isSemantic(declaration)) return [];
    return [...declaration.value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].flatMap((match) => {
      const hue = warmHue(match[0]);
      if (hue === null) return [];
      return [`${fileName}:${declaration.line} ${declaration.property}: ${match[0]} (hue ${hue}°) in ${declaration.selector}`];
    });
  });
}

describe("chat surface colour semantics", () => {
  it.each(STYLESHEETS)("keeps red and amber out of non-semantic positions in %s", (fileName) => {
    expect(warmViolations(fileName)).toEqual([]);
  });

  it("still finds a violation when one is introduced", () => {
    // Guards the detector itself: decorative warm colour must be caught, and
    // the arc must reach magenta and pink, not just red through yellow.
    const decorative: Declaration = { selector: ".attachment-tray span", property: "background", value: "#d6a51f", line: 1 };
    expect(isSemantic(decorative)).toBe(false);
    for (const banned of ["#d6a51f", "#f59e32", "#e43f38", "#b13fa0", "#e84b78", "#9333a8"]) {
      expect(warmHue(banned)).not.toBeNull();
    }
  });

  it("recognises the states that may keep their colour", () => {
    expect(warmHue("#e43f38")).not.toBeNull();
    for (const selector of [".inline-error", ".destructive", '.delivery-issue-mark[data-issue="unconfirmed"]', ".tech-strip button"]) {
      expect(isSemantic({ selector, property: "color", value: "#e43f38", line: 1 })).toBe(true);
    }
    expect(isSemantic({ selector: ".chat-app", property: "--danger", value: "#c0342b", line: 1 })).toBe(true);
  });

  it("does not mistake neutral surfaces or cool hues for warnings", () => {
    for (const cool of ["#0b7a5f", "#2f6f8f", "#3f5bbf", "#12857c", "#12968c", "#1f8fb5", "#0f6f78"]) {
      expect(warmHue(cool)).toBeNull();
    }
    expect(warmHue("#fff")).toBeNull();
    expect(warmHue("#2c2c2e")).toBeNull();
  });
});
