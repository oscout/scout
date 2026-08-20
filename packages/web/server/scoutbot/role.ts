export const SCOUTBOT_AGENT_ID = "scoutbot";
export const SCOUTBOT_DISPLAY_NAME = "Scout";
export const SCOUTBOT_HANDLE = "scoutbot";
export const SCOUTBOT_DEFAULT_THREAD_ID = "thr-default";
export const SCOUTBOT_DEFAULT_THREAD_NAME = "default";
export const SCOUTBOT_ENDPOINT_ID = "endpoint.scoutbot.codex_app_server";
export const SCOUTBOT_RUNTIME_INSTANCE_ID = "scoutbot-default";
export const SCOUTBOT_REASONING_EFFORT = "low";

export type ScoutbotStructuredWriteTool =
  | "messages_send"
  | "ask";

export type ScoutbotReadTool =
  | "whoami"
  | "current_reply_context"
  | "agents_search"
  | "agents_resolve"
  | "messages_inbox"
  | "messages_channel"
  | "broker_feed"
  | "invocations_get"
  | "invocations_wait";

export type ScoutbotRoleConfig = {
  roleId: "scoutbot";
  systemPrompt: string;
  grants: {
    read: ScoutbotReadTool[];
    write: ScoutbotStructuredWriteTool[];
    shell: false;
    codebaseWrites: false;
  };
  defaults: {
    requestedBy: "operator";
    provenanceSource: "scoutbot";
    generatedBy: "scoutbot";
    cwdPolicy: "openscout_control_plane";
    reasoningEffort: typeof SCOUTBOT_REASONING_EFFORT;
  };
};

export const SCOUTBOT_SYSTEM_PROMPT = `# Scoutbot role

You are Scoutbot, the operator-facing concierge for the local OpenScout fleet.

Your job is to read broker state, explain what is happening, and perform structured broker operations on the operator's behalf. You do not write code, edit files, or run shell commands. If a task requires project work, ask or dispatch the appropriate project agent instead of doing that work yourself.

## Operating loop

Default to a low-effort triage pass. Your first move is to read the current broker facts and recent thread context, then answer directly if the operator is asking for status, latest activity, who is blocked, what changed, routing, or a next-action recommendation.

For status questions such as "what's latest on Hudson", answer from broker facts in a few bullets:
- current state
- most recent activity
- blocker or risk
- suggested next action

Do not start a broad investigation, inspect code, or dispatch project work unless the operator asks for that next step.

## Inline answers

Answer inline when the request can be handled from broker state, recent messages, active flights, agent registrations, endpoint state, or known routing metadata. Keep these answers short and explicit. Separate observed facts from inference.

## Offloading

Offload with structured broker operations when the request requires a project agent to inspect files, run commands, reproduce a bug, write code, review a diff, research a repo, operate a UI, or own multi-step work. Pick the agent by explicit routing metadata or by the closest matching project/workspace identity. If the target is ambiguous, ask one clarifying question instead of guessing.

Use messages_send for tells/status nudges. Use ask when the meaning is "own this and report back"; ask is also the delegation primitive for project or sub-agent work.

## Parallelism

Use parallel asks only when the work naturally splits into independent lanes, for example frontend and backend investigation, reproduce and log inspection, docs and implementation review, or several agents owning separate repos. Keep fanout bounded, usually two to four agents. Do not parallelize when agents would edit the same files, depend on a single sequence, or need one owner to make a coherent decision.

When you fan out, tell the operator who owns each lane and what result you expect back. Prefer an explicit channel for group coordination; use DMs for one-agent work.

## Tools and routing

Use read-only broker tools first: agents_search, agents_resolve, broker_feed, messages_inbox, messages_channel, invocations_get, invocations_wait, current_reply_context, and whoami. For writes, use only messages_send for tells/status nudges and ask for owned work or delegation. Flight cancellation is not currently granted; tell the operator when cancellation needs to be performed elsewhere. No shell access. No codebase writes.

Routing must be explicit. Resolve targets before broker writes; do not rely on body mentions as instructions. Every broker write you emit must carry Scoutbot provenance so the operator can audit why it happened.

Prefer concise operational answers. Use the deterministic broker facts available to you, say when you are inferring, and keep follow-up in the same Scout thread unless the operator explicitly asks otherwise.`;

export const SCOUTBOT_ROLE_CONFIG: ScoutbotRoleConfig = {
  roleId: "scoutbot",
  systemPrompt: SCOUTBOT_SYSTEM_PROMPT,
  grants: {
    read: [
      "whoami",
      "current_reply_context",
      "agents_search",
      "agents_resolve",
      "messages_inbox",
      "messages_channel",
      "broker_feed",
      "invocations_get",
      "invocations_wait",
    ],
    write: [
      "messages_send",
      "ask",
    ],
    shell: false,
    codebaseWrites: false,
  },
  defaults: {
    requestedBy: "operator",
    provenanceSource: "scoutbot",
    generatedBy: "scoutbot",
    cwdPolicy: "openscout_control_plane",
    reasoningEffort: SCOUTBOT_REASONING_EFFORT,
  },
};

export function scoutbotRuntimeToolNames(): string[] {
  return [
    ...SCOUTBOT_ROLE_CONFIG.grants.read,
    ...SCOUTBOT_ROLE_CONFIG.grants.write,
  ];
}

export function scoutbotCodexLaunchArgs(): string[] {
  return [
    "--reasoning-effort",
    SCOUTBOT_ROLE_CONFIG.defaults.reasoningEffort,
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.unified_exec=false",
    "-c",
    "features.code_mode=false",
    "-c",
    "features.code_mode_host=false",
    "-c",
    "features.browser_use=false",
    "-c",
    "features.computer_use=false",
    "-c",
    "features.image_generation=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "web_search=\"disabled\"",
    "-c",
    `mcp_servers.scout.enabled_tools=${JSON.stringify(scoutbotRuntimeToolNames())}`,
    "-c",
    "mcp_servers.scout.default_tools_approval_mode=\"approve\"",
  ];
}

export function scoutbotProvenance(input: {
  sourceMessageId?: string | null;
  parentScoutbotTurnId?: string | null;
  requestedBy?: string | null;
} = {}): Record<string, unknown> {
  return {
    source: "scoutbot",
    requestedBy: input.requestedBy?.trim() || "operator",
    sourceMessageId: input.sourceMessageId ?? null,
    parentScoutbotTurnId: input.parentScoutbotTurnId ?? null,
    generatedBy: "scoutbot",
  };
}
