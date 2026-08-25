import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const required = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "LICENSE",
  "install.md",
  "llms.txt",
  "docs.json",
  "docs/public-source-boundary.md",
  "docs/releases.md",
  ".github/diagrams/control-plane.arc.json",
  ".github/diagrams/README.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/assets/scout-mark.svg",
  ".github/assets/avatar.svg",
  ".github/assets/avatar.png",
  ".github/assets/readme-hero.svg",
  ".github/assets/readme-hero.png",
  ".github/assets/social-preview.svg",
  ".github/assets/social-preview.png",
  "scripts/render-readme-diagram.mjs",
];

const missing = required.filter((path) => !existsSync(resolve(root, path)));
if (missing.length > 0) {
  throw new Error(`Missing public-repo surfaces:\n${missing.map((path) => `  - ${path}`).join("\n")}`);
}

const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "packages/agent-sessions/package.json",
  "packages/cli/package.json",
  "packages/protocol/package.json",
  "packages/runtime/package.json",
  "packages/session-trace/package.json",
  "packages/session-trace-react/package.json",
  "packages/web/package.json",
];
const versions = new Map(
  manifests.map((path) => [path, JSON.parse(read(path)).version]),
);
const distinctVersions = new Set(versions.values());
if (distinctVersions.size !== 1) {
  throw new Error(
    `Public package versions drifted:\n${[...versions].map(([path, version]) => `  - ${path}: ${version}`).join("\n")}`,
  );
}

const docsIndex = JSON.parse(read("docs.json"));
if (docsIndex.version !== versions.get("package.json")) {
  throw new Error(
    `Generated docs version ${docsIndex.version} does not match package version ${versions.get("package.json")}`,
  );
}

const diagram = JSON.parse(read(".github/diagrams/control-plane.arc.json"));
if (!Array.isArray(diagram.connectors) || diagram.connectors.length < 3) {
  throw new Error("Arc control-plane diagram is missing its routing relationships");
}
if (!read("README.md").includes("Generated from .github/diagrams/control-plane.arc.json by @arach/arc")) {
  throw new Error("README Arc diagram has not been rendered");
}

const linkedSurfaces = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "install.md",
  "docs/overview.md",
  "docs/quickstart.md",
  "docs/public-source-boundary.md",
  "docs/releases.md",
  ".github/assets/README.md",
];
const brokenTargets = [];
for (const surface of linkedSurfaces) {
  const markdown = read(surface);
  const localTargets = [
    ...markdown.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]+)?\)/g),
    ...markdown.matchAll(/(?:src|href)="((?:\.\.?\/)[^"#]+)(?:#[^"]+)?"/g),
  ].map((match) => match[1]);
  for (const target of localTargets) {
    if (!existsSync(resolve(root, dirname(surface), target))) {
      brokenTargets.push(`${surface} -> ${target}`);
    }
  }
}
if (brokenTargets.length > 0) {
  throw new Error(`Broken local README targets:\n${brokenTargets.map((target) => `  - ${target}`).join("\n")}`);
}

const forbiddenPlaceholder = /A great project|Feature 1|Describe what your project does|TODO: replace/i;
for (const path of ["README.md", "docs/overview.md", "docs/quickstart.md", "AGENTS.md", "install.md"]) {
  if (forbiddenPlaceholder.test(read(path))) {
    throw new Error(`Generic placeholder text remains in ${path}`);
  }
}

console.log(`presentation check passed (${[...distinctVersions][0]}; ${required.length} required surfaces)`);
