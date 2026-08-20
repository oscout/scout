import type { Agent } from "./types.ts";

export function compactAgentId(id: string | null | undefined): string | null {
  const trimmed = id?.trim();
  if (!trimmed) return null;

  const [head] = trimmed.split(".");
  return head?.trim() || trimmed;
}

export function minimalAgentHandle(input: {
  handle?: string | null;
  selector?: string | null;
  id?: string | null;
}): string | null {
  const handle = input.handle?.trim().replace(/^@+/, "");
  if (handle) return `@${handle}`;

  const selector = input.selector?.trim();
  if (selector) return selector;

  const compact = compactAgentId(input.id);
  return compact ? `@${compact}` : null;
}

export function minimalAgentDisplayName(input: {
  name?: string | null;
  agentName?: string | null;
  id?: string | null;
  title?: string | null;
}): string {
  return (
    input.name?.trim()
    || input.agentName?.trim()
    || compactAgentId(input.id)
    || input.title?.trim()
    || "Conversation"
  );
}

export function minimalAgentLabel(agent: Agent | null | undefined): string | null {
  if (!agent) return null;
  return minimalAgentDisplayName({
    name: agent.name,
    id: agent.id,
  });
}
