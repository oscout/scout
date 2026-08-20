export const LOCAL_AGENT_SYSTEM_PROMPT_TEMPLATE_HINT = [
  "Supports {{base_prompt}}, {{project_context}}, {{collaboration_prompt}}, {{collaboration_contract}}, {{protocol_prompt}}, {{protocol}}, {{agent_id}}, {{display_name}}, ",
  "{{project_name}}, {{project_path}}, {{project_root}}, {{workspace_root}}, {{cwd}}, {{projects_root}}, {{base_path}}, ",
  "{{relay_hub}}, {{broker_url}}, {{relay_command}}, {{openscout_root}}, {{relay_agent_comms_skill}}, and {{env.NAME}} variables.",
].join("");

/** Insertable `{{token}}` names for Scout UI; keep in sync with `renderLocalAgentSystemPromptTemplate` keys and `LOCAL_AGENT_SYSTEM_PROMPT_TEMPLATE_HINT`. */
export const LOCAL_AGENT_SYSTEM_PROMPT_INSERT_TOKENS = [
  "base_prompt",
  "project_context",
  "collaboration_prompt",
  "collaboration_contract",
  "protocol_prompt",
  "protocol",
  "agent_id",
  "display_name",
  "project_name",
  "project_path",
  "project_root",
  "workspace_root",
  "cwd",
  "projects_root",
  "base_path",
  "relay_hub",
  "broker_url",
  "relay_command",
  "openscout_root",
  "relay_agent_comms_skill",
] as const;

/** First N tokens in `LOCAL_AGENT_SYSTEM_PROMPT_INSERT_TOKENS` are composite prompt blocks; the rest are scalar substitutions. */
export const LOCAL_AGENT_SYSTEM_PROMPT_INSERT_BLOCK_COUNT = 6;
