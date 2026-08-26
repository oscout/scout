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

const npmReleaseWorkflow = read(".github/workflows/release-package-npm.yml");
if (
  !npmReleaseWorkflow.includes('minimum_version="0.2.91"')
  || !npmReleaseWorkflow.includes("(minor == 2 && patch < 91)")
  || !npmReleaseWorkflow.includes("This workflow publishes v${minimum_version} or later")
) {
  throw new Error("GitHub npm workflow must reject releases older than v0.2.91");
}
if (npmReleaseWorkflow.includes("NPM_TOKEN:")) {
  throw new Error("GitHub npm workflow must use trusted publishing without a legacy npm token");
}
const unpinnedReleaseActions = [...npmReleaseWorkflow.matchAll(/uses:\s+([^\s@]+)@([^\s#]+)/g)]
  .filter(([, , revision]) => !/^[0-9a-f]{40}$/.test(revision))
  .map(([, action, revision]) => `${action}@${revision}`);
if (unpinnedReleaseActions.length > 0) {
  throw new Error(`Trusted-publisher actions must use immutable commit pins: ${unpinnedReleaseActions.join(", ")}`);
}
if (!npmReleaseWorkflow.includes("  group: release-package-npm\n")) {
  throw new Error("GitHub npm releases must serialize registry-wide across version tags");
}
if (
  !npmReleaseWorkflow.includes("      recovery_run_id:\n")
  || !npmReleaseWorkflow.includes("Recovery run id must be a positive integer")
  || !npmReleaseWorkflow.includes("      - name: Validate recovery run\n")
  || !npmReleaseWorkflow.includes("        if: ${{ inputs.recovery_run_id != '' }}\n")
  || !npmReleaseWorkflow.includes("          run-id: ${{ inputs.recovery_run_id }}\n")
  || !npmReleaseWorkflow.includes(".github/workflows/release-package-npm.yml")
  || !npmReleaseWorkflow.includes("run_sha\" == \"$EXPECTED_SHA")
  || !npmReleaseWorkflow.includes("run_conclusion")
  || !npmReleaseWorkflow.includes("must expose exactly one live")
) {
  throw new Error("GitHub npm recovery must validate one explicit, exact-source recovery run and artifact");
}
if (
  !npmReleaseWorkflow.includes("          ref: refs/tags/${{ steps.release.outputs.tag }}\n")
  || !npmReleaseWorkflow.includes('[[ "$DISPATCH_REF" == "refs/heads/main" ]]')
  || !npmReleaseWorkflow.includes('[[ "$release_sha" == "$DISPATCH_SHA" ]]')
) {
  throw new Error("GitHub npm provenance must bind the explicit release tag to the attested main dispatch SHA");
}
const recoveryValidationIndex = npmReleaseWorkflow.indexOf(
  "      - name: Validate recovery run\n",
);
const restoreIndex = npmReleaseWorkflow.indexOf(
  "      - name: Restore exact release candidate bundle\n",
);
const prepareIndex = npmReleaseWorkflow.indexOf(
  "        run: bash scripts/ship-npm.sh --prepare\n",
);
const candidateUploadIndex = npmReleaseWorkflow.indexOf(
  "      - name: Upload exact release candidate bundle\n",
);
const publishIndex = npmReleaseWorkflow.indexOf(
  "          bash scripts/ship-npm.sh --publish-prepared\n",
);
const verifyIndex = npmReleaseWorkflow.indexOf(
  "          bash scripts/ship-npm.sh --verify-published\n",
);
const receiptIndex = npmReleaseWorkflow.indexOf(
  "      - name: Locate exact release receipt\n",
);
const finalReceiptUploadIndex = npmReleaseWorkflow.indexOf(
  "      - name: Upload exact release receipt\n",
);
if (
  recoveryValidationIndex < 0
  || restoreIndex < recoveryValidationIndex
  || prepareIndex < restoreIndex
  || candidateUploadIndex < prepareIndex
  || publishIndex < candidateUploadIndex
  || verifyIndex < publishIndex
  || receiptIndex < verifyIndex
  || finalReceiptUploadIndex < receiptIndex
) {
  throw new Error(
    "GitHub npm workflow must restore, prepare, retain, publish, verify, then upload its final receipt",
  );
}
const candidateArtifactName = /candidate_artifact_name=(scout-npm-[a-z-]+)-\$\{RELEASE_VERSION\}/
  .exec(npmReleaseWorkflow)?.[1];
const finalReceiptArtifactName = /name: (scout-npm-[a-z-]+)-\$\{\{ steps\.release\.outputs\.version \}\}/
  .exec(npmReleaseWorkflow)?.[1];
if (
  candidateArtifactName !== "scout-npm-candidate-bundle"
  || finalReceiptArtifactName !== "scout-npm-release-receipt"
  || candidateArtifactName === finalReceiptArtifactName
) {
  throw new Error("GitHub npm candidate and final receipt artifacts must have distinct names");
}
const releaseGuide = read("docs/releases.md");
if (
  !/workflow explicitly refuses `v0\.2\.90` and older/i.test(releaseGuide)
  || !/strict partial-set guard[\s\S]*neither package was promoted to[\s\S]*`latest`/i.test(releaseGuide)
) {
  throw new Error("Release guide must document the partial, unpromoted v0.2.88 attempt");
}
const sourceBoundary = read("docs/public-source-boundary.md");
if (
  !sourceBoundary.includes("## Broker-owned working set")
  || !/bounded, coherent working[\s\S]*rehydrated from the broker/i.test(sourceBoundary)
) {
  throw new Error("Public source boundary must keep registry state broker-owned and bounded");
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
