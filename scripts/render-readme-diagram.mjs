import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAscii } from "@arach/arc";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");
const diagramPath = join(root, ".github", "diagrams", "control-plane.arc.json");
const start = "<!-- arc:control-plane:start -->";
const end = "<!-- arc:control-plane:end -->";

const diagram = JSON.parse(readFileSync(diagramPath, "utf8"));
const ascii = renderAscii(diagram, { maxWidth: 92 });
const readme = readFileSync(readmePath, "utf8");

if (!readme.includes(start) || !readme.includes(end)) {
  throw new Error("README is missing the Arc control-plane markers");
}

const block = `${start}\n\n<!-- Generated from .github/diagrams/control-plane.arc.json by @arach/arc. -->\n\n\`\`\`text\n${ascii}\n\`\`\`\n\n${end}`;
const next = readme.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
writeFileSync(readmePath, next);

console.log("rendered README control-plane diagram with @arach/arc");
