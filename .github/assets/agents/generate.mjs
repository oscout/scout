// Generates one SVG pill per supported agent for the README "Supported agents" strip.
// Each pill embeds its mark, so the README needs no external requests, and
// follows the viewer's light/dark preference.
//
//   node .github/assets/agents/generate.mjs
//
// Marks are read from logos/ (see logos/SOURCES.md); pills are written next to this file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = dirname(fileURLToPath(import.meta.url));
const logoDir = join(outDir, "logos");

const AGENTS = [
  { id: "claude-code", label: "Claude Code", logo: "claude.svg" },
  { id: "codex", label: "Codex", logo: "codex.svg" },
  { id: "cursor", label: "Cursor", logo: "cursor.svg" },
  { id: "grok", label: "Grok CLI", logo: "grok.svg" },
  { id: "opencode", label: "OpenCode", logo: "opencode.svg" },
  { id: "kimi", label: "Kimi Code", logo: "kimi.svg" },
  { id: "devin", label: "Devin", logo: "devin.svg" },
  { id: "pi", label: "pi", logo: "pi.svg" },
  { id: "hermes", label: "Hermes Agent", logo: "hermes.png" },
  { id: "herdr", label: "Herdr", logo: "herdr.png", mono: true },
  { id: "mcp", label: "any MCP client", logo: "mcp.svg", prefix: "+" },
];

const HEIGHT = 24;
const ICON = 14;
const PAD = 8;
const GAP = 6;
const FONT = 11;
const CHAR = FONT * 0.6; // monospace advance

function mark({ logo: file, id, mono }, x, y) {
  const raw = readFileSync(join(logoDir, file));
  if (file.endsWith(".png")) {
    const href = `data:image/png;base64,${raw.toString("base64")}`;
    // A one-colour mark is used as an alpha mask so it takes the text colour in both schemes.
    if (mono) {
      return `<mask id="m-${id}" style="mask-type:alpha"><image x="${x}" y="${y}" width="${ICON}" height="${ICON}" href="${href}"/></mask><rect x="${x}" y="${y}" width="${ICON}" height="${ICON}" fill="currentColor" mask="url(#m-${id})"/>`;
    }
    return `<image x="${x}" y="${y}" width="${ICON}" height="${ICON}" href="${href}"/>`;
  }
  const svg = raw.toString("utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/<title>[\s\S]*?<\/title>/g, "");
  const open = svg.match(/<svg\b[^>]*>/)[0];
  const viewBox = open.match(/viewBox="([^"]+)"/)[1];
  const body = svg.slice(svg.indexOf(open) + open.length, svg.lastIndexOf("</svg>"));
  const fillRule = open.match(/fill-rule="([^"]+)"/);
  const fill = open.match(/\bfill="([^"]+)"/);
  const attrs = [fill ? `fill="${fill[1]}"` : "", fillRule ? `fill-rule="${fillRule[1]}"` : ""].join(" ");
  return `<svg x="${x}" y="${y}" width="${ICON}" height="${ICON}" viewBox="${viewBox}" ${attrs}>${body.trim()}</svg>`;
}

function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function pill(agent) {
  const text = agent.prefix ? `${agent.prefix} ${agent.label}` : agent.label;
  const width = Math.ceil(PAD + ICON + GAP + text.length * CHAR + PAD);
  const iconY = (HEIGHT - ICON) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${escape(agent.label)}">
<style>
  .bg { fill: #f6f8fa; stroke: #d0d7de; }
  .fg { fill: #1f2328; color: #1f2328; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #161b22; stroke: #30363d; }
    .fg { fill: #e6edf3; color: #e6edf3; }
  }
</style>
<rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${HEIGHT - 1}" rx="5"/>
<g class="fg">${mark(agent, PAD, iconY)}</g>
<text class="fg" x="${PAD + ICON + GAP}" y="${HEIGHT / 2}" dominant-baseline="central" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT}">${escape(text)}</text>
</svg>
`;
}

mkdirSync(outDir, { recursive: true });
for (const agent of AGENTS) writeFileSync(join(outDir, `${agent.id}.svg`), pill(agent));
console.log(`Generated ${AGENTS.length} agent pills in ${outDir}`);
