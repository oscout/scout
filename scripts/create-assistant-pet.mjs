import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharpModulePath = path.join(root, "landing/node_modules/sharp/lib/index.js");
const { default: sharp } = await import(sharpModulePath);

const outDir = path.join(root, "assets/pets/scout-ranger");
const cellWidth = 192;
const cellHeight = 208;
const columns = 8;
const rows = 9;
const atlasWidth = cellWidth * columns;
const atlasHeight = cellHeight * rows;

const states = [
  { key: "idle", label: "Idle", frames: 6, row: 0 },
  { key: "run_right", label: "Run Right", frames: 8, row: 1 },
  { key: "run_left", label: "Run Left", frames: 8, row: 2 },
  { key: "waving", label: "Waving", frames: 4, row: 3 },
  { key: "jumping", label: "Jumping", frames: 5, row: 4 },
  { key: "failed", label: "Failed", frames: 8, row: 5 },
  { key: "waiting", label: "Waiting", frames: 6, row: 6 },
  { key: "running", label: "Running", frames: 6, row: 7 },
  { key: "review", label: "Review", frames: 6, row: 8 },
];

await mkdir(outDir, { recursive: true });

function frameSvg(state, frame) {
  const t = frame / Math.max(1, state.frames - 1);
  const cycle = Math.sin(t * Math.PI * 2);
  const hop = state.key === "jumping" ? -Math.sin(t * Math.PI) * 36 : 0;
  const bob = cycle * (state.key === "idle" ? 3 : state.key === "waiting" ? 2 : 5);
  const drift =
    state.key === "run_right" ? (t - 0.5) * 42 :
    state.key === "run_left" ? (0.5 - t) * 42 :
    state.key === "running" ? cycle * 10 :
    0;
  const tilt =
    state.key === "run_right" ? 8 :
    state.key === "run_left" ? -8 :
    state.key === "failed" ? cycle * 5 :
    state.key === "review" ? cycle * 2 :
    0;
  const y = 102 + hop + bob;
  const x = 96 + drift;
  const core = state.key === "failed" ? "#ff657a" : state.key === "review" ? "#ffd166" : "#b7e36a";
  const accent = state.key === "waiting" ? "#9bb36b" : state.key === "failed" ? "#ffb3bf" : "#f4c95d";
  const trim = state.key === "failed" ? "#ff9cac" : "#384d2a";
  const eyeShift = state.key === "review" ? Math.round(cycle * 3) : 0;
  const blink = state.key === "idle" && frame === 3;
  const wave = state.key === "waving" ? Math.sin(t * Math.PI * 2) * 20 : 0;
  const antenna = state.key === "waiting" ? 7 + Math.abs(cycle) * 5 : 8;
  const mouth =
    state.key === "failed" ? "M82 116 Q96 108 110 116" :
    state.key === "review" ? "M84 114 Q96 120 108 114" :
    "M84 113 Q96 122 108 113";

  return `
<svg width="${cellWidth}" height="${cellHeight}" viewBox="0 0 ${cellWidth} ${cellHeight}" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(${x} ${y}) rotate(${tilt}) translate(${-x} ${-y})">
    <ellipse cx="${x}" cy="${y + 44}" rx="38" ry="9" fill="#0b1020" opacity="0.22"/>
    <path d="M${x - 44} ${y - 49} Q${x} ${y - 78} ${x + 44} ${y - 49} L${x + 34} ${y - 34} Q${x} ${y - 45} ${x - 34} ${y - 34} Z" fill="#24351f"/>
    <path d="M${x - 38} ${y - 46} Q${x} ${y - 64} ${x + 38} ${y - 46}" fill="none" stroke="#607a3b" stroke-width="7" stroke-linecap="round"/>
    <circle cx="${x}" cy="${y - 50}" r="${antenna}" fill="${accent}" opacity="0.98"/>
    <path d="M${x - 6} ${y - 50} l6 -8 l6 8 l-7 2 l-1 8 l-4 -7 l-8 3 z" fill="#fff4b0" opacity="0.95"/>
    <rect x="${x - 44}" y="${y - 36}" width="88" height="80" rx="24" fill="#1b2819"/>
    <rect x="${x - 38}" y="${y - 30}" width="76" height="68" rx="20" fill="#2e4427"/>
    <path d="M${x - 33} ${y - 23} Q${x} ${y - 42} ${x + 33} ${y - 23} L${x + 26} ${y + 18} Q${x} ${y + 36} ${x - 26} ${y + 18} Z" fill="${core}" opacity="0.96"/>
    <path d="M${x - 19} ${y - 10} l9 11 l14 -18 l8 8 l13 -12" fill="none" stroke="#24351f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.82"/>
    ${
      blink
        ? `<path d="M${x - 22} ${y + 7} h12 M${x + 10} ${y + 7} h12" stroke="#07111f" stroke-width="4" stroke-linecap="round"/>`
        : `<circle cx="${x - 16 + eyeShift}" cy="${y + 5}" r="5" fill="#07111f"/><circle cx="${x + 16 + eyeShift}" cy="${y + 5}" r="5" fill="#07111f"/>`
    }
    <path d="${mouth}" transform="translate(${x - 96} ${y - 102})" fill="none" stroke="#07111f" stroke-width="4" stroke-linecap="round"/>
    <path d="M${x - 43} ${y - 2} Q${x - 62} ${y + 5} ${x - 62} ${y + 24}" fill="none" stroke="#1b2819" stroke-width="12" stroke-linecap="round"/>
    <path d="M${x + 43} ${y - 2} Q${x + 62} ${y + 5 + wave} ${x + 62} ${y + 24 - wave}" fill="none" stroke="#1b2819" stroke-width="12" stroke-linecap="round"/>
    <circle cx="${x - 62}" cy="${y + 26}" r="8" fill="${accent}"/>
    <circle cx="${x + 62}" cy="${y + 24 - wave}" r="8" fill="${accent}"/>
    <path d="M${x - 33} ${y + 29} h66" stroke="${trim}" stroke-width="8" stroke-linecap="round"/>
    <circle cx="${x}" cy="${y + 29}" r="6" fill="#fff4b0"/>
    <path d="M${x - 22} ${y + 39} v19 M${x + 22} ${y + 39} v19" stroke="#1b2819" stroke-width="13" stroke-linecap="round"/>
    <circle cx="${x - 22}" cy="${y + 61}" r="8" fill="${accent}"/>
    <circle cx="${x + 22}" cy="${y + 61}" r="8" fill="${accent}"/>
    ${
      state.key === "review"
        ? `<path d="M${x + 44} ${y - 48} h26 M${x + 44} ${y - 36} h19 M${x + 44} ${y - 24} h24" stroke="#ffd166" stroke-width="5" stroke-linecap="round" opacity="0.9"/>`
        : ""
    }
    ${
      state.key === "failed"
        ? `<path d="M${x + 47} ${y - 47} l20 20 M${x + 67} ${y - 47} l-20 20" stroke="#ff657a" stroke-width="6" stroke-linecap="round"/>`
        : ""
    }
  </g>
</svg>`;
}

const composites = [];

for (const state of states) {
  for (let frame = 0; frame < state.frames; frame += 1) {
    const input = Buffer.from(frameSvg(state, frame));
    composites.push({
      input,
      left: frame * cellWidth,
      top: state.row * cellHeight,
    });
  }
}

await sharp({
  create: {
    width: atlasWidth,
    height: atlasHeight,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(composites)
  .webp({ quality: 95, lossless: true })
  .toFile(path.join(outDir, "spritesheet.webp"));

await sharp(path.join(outDir, "spritesheet.webp"))
  .png()
  .toFile(path.join(outDir, "spritesheet.png"));

const pet = {
  id: "scout-ranger",
  displayName: "Scout Ranger",
  description: "A tiny chunky robot field-general companion for Scout and Codex sessions.",
  spritesheetPath: "spritesheet.webp",
};

await sharp({
  create: {
    width: cellWidth * columns,
    height: cellHeight * rows,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
})
  .composite(composites)
  .png()
  .toFile(path.join(outDir, "contact-sheet.png"));

await writeFile(path.join(outDir, "pet.json"), `${JSON.stringify(pet, null, 2)}\n`);

console.log(outDir);
