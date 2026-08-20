/**
 * ASCII render of the Scout wire-cube mark.
 *
 * The coverage field was rasterised from
 * `design/logo-attempts/focused-03-wire-cube-mark.svg` in the design studio's
 * `/studies/ascii-render-lab`. Keeping the render here lets every local-first
 * surface—including cold-start pages with no web assets—share one identity.
 *
 * Animation rule: occupancy is fixed from the coverage field (Bayer-masked).
 * Shimmer only walks tone/luminance across that mask so the silhouette never
 * breathes cells in and out.
 */
const ORB_COLS = 60;
const ORB_ROWS = 47;

/** Row-major coverage, one base64-alphabet character per cell, 64 levels. */
const ORB_FIELD =
  "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";

const ORB_CEIL = 0.83;
const ORB_GAMMA = 0.72;
const ORB_GAIN = 1.55;
const ORB_TONES = 4;
const ORB_GLYPH = "\u2591";
const ORB_BAYER = [
  [0.125, 0.625],
  [0.875, 0.375],
];
/** Shimmer amplitude over fixed cells (0 = flat tone, 1 = full swing). */
const ORB_SHIMMER_AMP = 0.34;
const ORB_STILL = 0.42;
const ORB_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function fieldRaw(x: number, y: number): number {
  return ORB_ALPHABET.indexOf(ORB_FIELD[y * ORB_COLS + x]) / 63;
}

/** Static occupancy from coverage only — never depends on time. */
function isOccupied(raw: number, x: number, y: number): boolean {
  let base = clamp01(raw) / ORB_CEIL;
  base = Math.pow(clamp01(base), ORB_GAMMA);
  return base * ORB_GAIN > ORB_BAYER[y % 2][x % 2];
}

/** Luminance multiplier for tone walk; does not affect occupancy. */
function orbShimmer(x: number, y: number, t: number): number {
  const nx = (x / (ORB_COLS - 1)) * 2 - 1;
  const ny = (y / (ORB_ROWS - 1)) * 2 - 1;
  const a = (120 * Math.PI) / 180;
  const u = nx * Math.cos(a) + ny * Math.sin(a) - t;
  const c = Math.pow(Math.cos(u * Math.PI * 2) * 0.5 + 0.5, 2.8);
  return 1 - ORB_SHIMMER_AMP + ORB_SHIMMER_AMP * c * 2;
}

/** Map coverage × shimmer to a tone layer index 0..4. Occupied cells always emit. */
function toneFor(raw: number, x: number, y: number, t: number): number {
  let v = clamp01(raw * orbShimmer(x, y, t)) / ORB_CEIL;
  v = Math.pow(clamp01(v), ORB_GAMMA);
  // Keep occupied cells away from empty: bias into the tone ladder.
  const step = Math.min(ORB_TONES - 1, Math.max(0, Math.floor(v * ORB_TONES)));
  return Math.round((step * 4) / (ORB_TONES - 1));
}

/** One frame, as five tone layers of text. Pure—no canvas, no DOM. */
function renderScoutAsciiMarkFrame(t: number): string[] {
  const layers: string[][] = [[], [], [], [], []];
  for (let y = 0; y < ORB_ROWS; y += 1) {
    const rows = ["", "", "", "", ""];
    for (let x = 0; x < ORB_COLS; x += 1) {
      const raw = fieldRaw(x, y);
      if (!isOccupied(raw, x, y)) {
        for (let i = 0; i < 5; i += 1) rows[i] += " ";
        continue;
      }
      const tone = toneFor(raw, x, y, t);
      for (let i = 0; i < 5; i += 1) {
        rows[i] += i === tone ? ORB_GLYPH : " ";
      }
    }
    for (let i = 0; i < 5; i += 1) layers[i].push(rows[i]);
  }
  return layers.map((rows) => rows.join("\n"));
}

/** Five stacked preformatted tone layers with a complete first-paint frame. */
export function renderScoutAsciiMarkHtml(): string {
  return renderScoutAsciiMarkFrame(ORB_STILL)
    .map((text, i) => `<pre class="orb-l" data-t="${i}">${text}</pre>`)
    .join("");
}

/** Progressive-enhancement shimmer for a mark rendered by the function above. */
export function renderScoutAsciiMarkScript(): string {
  return `<script>
(function () {
  var els = document.querySelectorAll(".orb-l");
  if (els.length !== 5 || !window.requestAnimationFrame) return;
  var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  var F = "${ORB_FIELD}";
  var A = "${ORB_ALPHABET}";
  var COLS = ${ORB_COLS}, ROWS = ${ORB_ROWS};
  var BAYER = [[0.125, 0.625], [0.875, 0.375]];
  var CEIL = ${ORB_CEIL}, GAMMA = ${ORB_GAMMA}, GAIN = ${ORB_GAIN};
  var TONES = ${ORB_TONES}, AMP = ${ORB_SHIMMER_AMP};
  var STILL = ${ORB_STILL};
  var raf = 0, last = 0;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function occupied(raw, x, y) {
    var base = Math.pow(clamp01(clamp01(raw) / CEIL), GAMMA);
    return base * GAIN > BAYER[y % 2][x % 2];
  }

  function toneOf(raw, x, y, t) {
    var nx = (x / (COLS - 1)) * 2 - 1;
    var ny = (y / (ROWS - 1)) * 2 - 1;
    var u = nx * Math.cos(2.0943951) + ny * Math.sin(2.0943951) - t;
    var c = Math.pow(Math.cos(u * Math.PI * 2) * 0.5 + 0.5, 2.8);
    var shimmer = 1 - AMP + AMP * c * 2;
    var v = Math.pow(clamp01(clamp01(raw * shimmer) / CEIL), GAMMA);
    var step = Math.min(TONES - 1, Math.max(0, Math.floor(v * TONES)));
    return Math.round(step * 4 / (TONES - 1));
  }

  function frame(t) {
    var out = ["", "", "", "", ""];
    for (var y = 0; y < ROWS; y++) {
      for (var x = 0; x < COLS; x++) {
        var raw = A.indexOf(F.charAt(y * COLS + x)) / 63;
        if (!occupied(raw, x, y)) {
          for (var i = 0; i < 5; i++) out[i] += " ";
        } else {
          var tone = toneOf(raw, x, y, t);
          for (var j = 0; j < 5; j++) out[j] += j === tone ? "\\u2591" : " ";
        }
      }
      if (y < ROWS - 1) for (var k = 0; k < 5; k++) out[k] += "\\n";
    }
    for (var m = 0; m < 5; m++) els[m].textContent = out[m];
  }

  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (ts - last < 48) return;
    last = ts;
    frame(STILL + (ts / 1000) * 0.38);
  }
  function sync() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (mq.matches || document.hidden) frame(STILL);
    else raf = requestAnimationFrame(loop);
  }
  if (mq.addEventListener) mq.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
})();
</script>`;
}
