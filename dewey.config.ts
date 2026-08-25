import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default {
  project: {
    name: "Scout",
    tagline: "One local control plane for every coding agent you run.",
    type: "monorepo",
    version: packageMetadata.version,
  },

  agent: {
    criticalContext: [
      "Use Bun for JavaScript and TypeScript workflows.",
      "The broker is the canonical writer for Scout-owned coordination records.",
      "External harness transcripts are observed source material; never bulk-import them as Scout messages.",
      "One explicit target is a DM; group coordination requires an explicit channel; broadcast is opt-in.",
      "Use scout send for tells and scout ask for requested work or replies.",
      "Mesh means reachability and coordination, not exactly-once delivery or global consensus.",
      "Scout is for high-trust local developer pilots; do not claim enterprise or compliance readiness.",
      "Use gitmoji commit subjects and never add AI co-authoring footers.",
    ],

    entryPoints: {},

    rules: [
      { pattern: "packages/protocol/**", instruction: "Run bun run --cwd packages/protocol check." },
      { pattern: "packages/runtime/**", instruction: "Run bun run --cwd packages/runtime check and the narrow affected tests." },
      { pattern: "apps/desktop/**", instruction: "Run bun run --cwd apps/desktop check." },
      { pattern: "process spawning or shell execution", instruction: "Run bun run sync-exec:fence before committing shell-execution changes." },
    ],

    sections: ["overview", "quickstart"],
  },

  docs: {
    path: "./docs",
    output: "./",
    required: ["overview", "quickstart"],
  },

  install: {
    objective: "Install Scout and verify the local broker control plane.",
    doneWhen: {
      command: "scout doctor",
      expectedOutput: "A Scout readiness report with no blocking setup error.",
    },
    prerequisites: [
      "Bun 1.3 or newer",
      "macOS or Linux",
      "At least one supported coding-agent harness for routed work",
    ],
    steps: [
      { description: "Install the Scout CLI and bundled runtime", command: "bun add -g @openscout/scout" },
      { description: "Initialize local Scout state and services", command: "scout setup" },
      { description: "Verify local readiness", command: "scout doctor" },
      { description: "Confirm the inferred sender identity", command: "scout whoami" },
      { description: "List available targets", command: "scout who" },
    ],
  },
}
