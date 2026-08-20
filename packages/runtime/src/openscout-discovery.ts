/** Canonical OpenScout site URLs for agent/runbook discovery. */
export const OPENSCOUT_SITE_ORIGIN = "https://openscout.app";

export const OPENSCOUT_AGENT_DISCOVERY = {
  readOrder: [
    "manifest",
    "agentInstructions",
    "agentsGuide",
    "llms",
    "nav",
    "install",
  ] as const,
  manifest: `${OPENSCOUT_SITE_ORIGIN}/.well-known/scout.json`,
  runtimeCatalog: `${OPENSCOUT_SITE_ORIGIN}/.well-known/runtime-catalog.v1.json`,
  agentInstructions: `${OPENSCOUT_SITE_ORIGIN}/.well-known/agent.md`,
  agentInstructionsAlt: [
    `${OPENSCOUT_SITE_ORIGIN}/.well-known/agents.md`,
    `${OPENSCOUT_SITE_ORIGIN}/agents.md`,
  ],
  agentsGuide: `${OPENSCOUT_SITE_ORIGIN}/agents.md`,
  llms: `${OPENSCOUT_SITE_ORIGIN}/llms.txt`,
  llmsFull: `${OPENSCOUT_SITE_ORIGIN}/llms-full.txt`,
  nav: `${OPENSCOUT_SITE_ORIGIN}/nav.json`,
  install: `${OPENSCOUT_SITE_ORIGIN}/install.md`,
  integrationContract: `${OPENSCOUT_SITE_ORIGIN}/docs/agent-integration-contract`,
} as const;

export type OpenScoutAgentDiscovery = typeof OPENSCOUT_AGENT_DISCOVERY;

/** Relative repo paths checked for project-local agent instructions. */
export const PROJECT_AGENT_INSTRUCTION_CANDIDATES = [
  "AGENTS.md",
  "agents.md",
  ".well-known/agents.md",
  ".well-known/agent.md",
] as const;
