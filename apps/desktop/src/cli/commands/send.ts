import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { resolveMessageBody } from "../input-file.ts";
import { parseSendCommandOptions } from "../options.ts";
import {
  parseScoutHarness,
  resolveScoutSenderId,
  sendScoutMessage,
  type ScoutMessagePostResult,
} from "../../core/broker/service.ts";
import { renderScoutMessagePostResult } from "../../ui/terminal/broker.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

export function renderSendCommandHelp(): string {
  return [
    "Usage: scout send [--as <sender>] [--to <agent> | --ref <ref>] [--alias-project <path>] [--alias-host <node>] [--channel <name>] [--speak] [--wake] [--harness <runtime>] [--message-file <path> | <message>]",
    "",
    "Tell or update another agent or an explicit channel.",
    "",
    "Routing:",
    "  --to <agent>                      -> DM; body @mentions stay text",
    "  --to target:<name> or --to ⌖name   -> saved situated target",
    "  --to alias:<name>                  -> explicit broker route alias; optional qualified alias scope",
    "  one explicit @agent + no channel   -> DM",
    "  --channel <name>                   -> named group thread",
    "  no target + no channel             -> error",
    "  multiple targets + no channel      -> error",
    "",
    "Use send only when no reply, judgment, investigation, or owned work is expected.",
    "Use `scout ask` when the meaning is \"do this and get back to me.\" When in doubt, use ask.",
    "For asynchronous work, do not downgrade an ask to send: use `scout ask --notify` so Scout returns now and reports completion later.",
    "Targeted DMs dispatch automatically when the broker can reach the agent.",
    "Add --wake only when you need to force an explicit wake turn or runtime harness.",
    "",
    "Input:",
    "  inline message                    -> message body",
    "  --message-file <path>             -> read the message body from a UTF-8 file",
    "  --body-file <path>                -> alias for --message-file",
    "",
    "Examples:",
    '  scout send --to hudson "ready for review; literal @codex stays text"',
    '  scout send --to target:mw-talkie "status update for that worker"',
    '  scout send --ref 7f3a9c21 "follow-up for that bound session"',
    '  scout send --to lattices#codex?5.5 "ready for review"',
    '  scout send --to hudson --wake "please apply the chrome feedback; no reply needed"',
    "  scout send --channel triage --message-file ./status.md",
    '  scout send --as premotion.master.mini --to hudson "editor branch is green"',
    '  scout send --channel triage "need two reviewers"',
    '  scout send "@hudson ready for review"  # legacy body-mention shorthand',
  ].join("\n");
}

function renderTargetLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return "";
  }
  if (
    trimmed.startsWith("@")
    || /^(?:ref|session|target|target-handle|target_handle|channel):/i.test(trimmed)
    || /^broadcast$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return `@${trimmed}`;
}

function renderAmbiguousCandidate(label: string): string {
  const rendered = renderTargetLabel(label);
  return rendered || label.trim();
}

export function formatScoutSendRoutingError(
  result: Pick<ScoutMessagePostResult, "targetDiagnostic" | "unresolvedTargets">,
): string {
  const diagnostic = result.targetDiagnostic;
  if (diagnostic?.state === "unknown") {
    return `there is no ${renderTargetLabel(diagnostic.agentId)}; nothing was sent.`;
  }
  if (diagnostic?.state === "ambiguous") {
    const renderedCandidates = diagnostic.candidates
      .map((candidate) => renderAmbiguousCandidate(candidate.label || candidate.agentId))
      .filter((label) => label.length > 0);
    if (renderedCandidates.length > 0) {
      return `target ${renderTargetLabel(result.unresolvedTargets[0] ?? "")} matches multiple agents: ${renderedCandidates.join(", ")}. Re-run with the fully qualified form (e.g. \`scout send --to ${renderedCandidates[0]} "..."\`).`;
    }
    if (diagnostic.detail) {
      return `${diagnostic.detail} Nothing was sent.`;
    }
    return `target ${renderTargetLabel(result.unresolvedTargets[0] ?? "")} matches multiple agents; nothing was sent. Re-run with a fully qualified @handle to disambiguate.`;
  }
  if (diagnostic?.state === "unavailable") {
    const runtime = diagnostic.transport ? ` (${diagnostic.transport})` : "";
    const wakePolicy = diagnostic.wakePolicy ? ` [wake:${diagnostic.wakePolicy}]` : "";
    return `target ${renderTargetLabel(result.unresolvedTargets[0] ?? diagnostic.agentId)} is known but currently unavailable${runtime}${wakePolicy}; nothing was sent. ${diagnostic.detail}`;
  }
  if (diagnostic?.state === "invalid" || diagnostic?.state === "missing") {
    return `${diagnostic.detail}; nothing was sent.`;
  }

  const rendered = result.unresolvedTargets
    .map(renderTargetLabel)
    .filter((label) => label.length > 0);
  if (rendered.length === 1) {
    return `target ${rendered[0]} is not uniquely routable; nothing was sent.`;
  }
  return `targets ${rendered.join(", ")} are not uniquely routable; nothing was sent.`;
}

function formatScoutRouteChoiceError(
  routingError:
    | "missing_destination"
    | "multi_target_requires_explicit_channel",
): string {
  if (routingError === "missing_destination") {
    return "message has no explicit destination; use @agent for a DM, --channel <name> for a group thread, or scout broadcast for channel.shared.";
  }
  return "message targets multiple agents without an explicit channel; send separate DMs, use --channel <name> for a group thread, or use scout broadcast for channel.shared.";
}

export async function runSendCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderSendCommandHelp());
    return;
  }

  const options = parseSendCommandOptions(
    args,
    defaultScoutContextDirectory(context),
  );
  const currentDirectory =
    options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(
    options.agentName,
    currentDirectory,
    context.env,
  );
  const body = await resolveMessageBody(options);
  const result = await sendScoutMessage({
    senderId,
    body,
    targetLabel: options.targetLabel,
    targetRef: options.targetRef,
    channel: options.channel,
    shouldSpeak: options.shouldSpeak,
    wake: options.wake,
    executionHarness: parseScoutHarness(options.harness),
    currentDirectory: options.currentDirectory,
    aliasScope: options.aliasProject || options.aliasHost ? {
      ...(options.aliasProject ? { projectRoot: options.aliasProject } : {}),
      ...(options.aliasHost ? { nodeId: options.aliasHost } : {}),
    } : undefined,
  });

  if (!result.usedBroker) {
    throw new Error("broker is not reachable");
  }
  if (result.unresolvedTargets.length > 0) {
    throw new Error(formatScoutSendRoutingError(result));
  }
  if (result.routingError) {
    throw new Error(formatScoutRouteChoiceError(result.routingError));
  }

  context.output.writeValue(
    {
      senderId,
      conversationId: result.conversationId,
      messageId: result.messageId,
      message: body,
      bindingRef: result.bindingRef,
      flightId: result.flight?.id,
      invokedTargets: result.invokedTargets,
      unresolvedTargets: result.unresolvedTargets,
      routeKind: result.routeKind,
    },
    renderScoutMessagePostResult,
  );
}
