import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import {
  parseAskCommandOptions,
  type ScoutAskCommandOptions,
} from "../options.ts";
import { resolvePromptBody } from "../input-file.ts";
import { scoutAskHandler } from "../../core/broker/ask.ts";
import type {
  ScoutAskReceipt,
} from "../../core/broker/ask-types.ts";
import {
  loadScoutFlight,
  parseScoutHarness,
  resolveHumanAskSenderName,
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
  type ScoutAskResult,
  type ScoutFlightRecord,
  waitForScoutFlight,
} from "../../core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_ASK_ACK_TIMEOUT_SECONDS = 30;
const DEFAULT_ASK_DISPATCH_SETTLE_MS = 4_000;

export function renderAskCommandHelp(): string {
  return [
    "Usage: scout ask [(--to <existing-target> | --ref <ref> | --project <path> | --profile <runtime-profile>)] [--runtime <harness/model/effort>] [--harness <runtime>] [--model <model>] [--effort <level>] [--new] [--placement <background|foreground> | --foreground] [--notify | --reply-mode <inline|notify|none>] [--prompt-file <path> | <message>]",
    "",
    "Ask one agent to do work or return a concrete answer.",
    "",
    "Routing:",
    "  one target + no channel            -> DM",
    "  --channel <name>                   -> named group thread",
    "  --to <name>                        -> existing agent/session target routing",
    "  agent <name> to <request>          -> exact normalized existing handle lookup",
    "  Fable|Kimi|Grok|Opus <request>     -> broker runtime profile; starts a fresh current-project session",
    "  --profile <name> [--effort <level>] -> explicit profile route; effort is supported by Fable/Opus",
    "  --to target:<name> or --to ⌖name    -> saved situated target; continues that worker",
    "  --to session:<id>                  -> continue one exact existing session",
    "  --to alias:<name>                  -> explicit broker route alias; use --alias-project/--alias-host for cross-scope routing",
    "  --project <path>                   -> ask by repo/workspace path; Scout resolves the concrete worker",
    "  --project <path> --harness <rt>     -> capability request; broker chooses/creates worker",
    "  --runtime <harness/model/effort>    -> exact shell-safe runtime; fixed slash positions",
    "  codex/gpt-5.6-sol/xhigh to ...      -> natural RuntimeSpec form for the current project",
    "  --model/--effort                    -> exact dimensions; legal with --harness or as profile overrides",
    "  --harness <runtime> with no target  -> ask a compatible worker for the current project",
    "  '>> project:<path> ...'             -> composer route form for the same project-path ask",
    "",
    "Use ask whenever a reply, judgment, investigation, review, implementation, or owned next step is expected.",
    "If the meaning is \"do this and get back to me,\" use ask. When in doubt, use ask.",
    "Do not use send merely to avoid blocking: `--notify` returns after the broker receipt and reports completion later.",
    "The command creates durable broker work; the target should acknowledge quickly in the same DM or channel.",
    `Default inline mode returns once the target has acknowledged, completed immediately, or stays unacknowledged for ${DEFAULT_ASK_ACK_TIMEOUT_SECONDS}s.`,
    "Use the returned ref/flight id/conversation/session handle for follow-up.",
    "Agent-card targets are fresh-session requests. Use a session id only when you intend to keep exact prior context.",
    "Exact runtime asks use: explicit flag/literal > profile preset > endpoint > harness config > default.",
    "Exact runtime on a named agent spawns an isolated session. An exact session id must already have matching observed runtime evidence.",
    "Bare target priority: profile id, then harness id; model names are never bare agent targets.",
    "Conflicting overlapping runtime values fail; a redundant same-value flag is accepted.",
    "Use --project when you know the project path but do not want to look up or pin an agent id first.",
    "Do not guess generic names like claude.main; let the broker route, then pin/name a good worker later.",
    "Use --harness without a target when the current project should be handled by that runtime.",
    "New sessions default to background. Use --foreground when you want a top-level task in the destination harness UI.",
    "Codex foreground tasks appear in the operator's Codex app; Scout does not open or focus the app.",
    "",
    "Input:",
    "  inline message                    -> primary prompt body",
    "  --prompt-file <path>              -> read the primary prompt body from a UTF-8 file",
    "  --body-file <path>                -> alias for --prompt-file",
    "  --label <label>                   -> attach a durable work label; repeatable",
    "  --notify                          -> asynchronous ask; return now and surface completion later",
    "  --reply-mode <mode>                -> inline (default), notify, or none",
    "  --placement <placement>           -> background (default) or foreground",
    "  --foreground                      -> alias for --placement foreground",
    "",
    "Examples:",
    '  scout ask --to hudson "review the parser"',
    '  scout ask agent Composer Review to fix the tests',
    '  scout ask Fable to review the parser',
    '  scout ask Opus high to review the parser',
    '  scout ask --profile kimi "review the parser"',
    '  scout ask --to target:mw-talkie "continue the editorial pass"',
    '  scout ask --to alias:review --alias-project ../talkie --alias-host mini "take another pass"',
    '  scout ask --ref 7f3a9c21 "continue from that result"',
    '  scout ask --project ../talkie "how did you handle auth?"',
    '  scout ask --harness codex "review this from a fresh Codex session"',
    '  scout ask --harness codex --foreground "review this where I can chime in from Codex"',
    '  scout ask --project ../talkie --harness codex --model gpt-5.6-sol --effort xhigh "review auth"',
    '  scout ask codex/gpt-5.6-sol/xhigh to review the diff',
    '  scout ask --project ../talkie --harness claude "review Talkie from Claude"',
    "  scout ask '>> project:../talkie compare auth against this branch'",
    "  scout ask --to hudson --prompt-file ./handoff.md",
    '  scout ask --as premotion.master.mini --to hudson "build the editor"',
    '  scout ask --to hudson --reply-mode notify "take the next pass and report back"',
    '  scout ask --to hudson --no-wait "start the longer implementation"',
    '  scout ask --to hudson --label release:0.2.66 "review the package bump"',
    '  scout ask --to vox.harness:codex "take another pass on the runtime fix"',
    '  scout ask --to lattices#codex?5.5 "take task A"',
    '  scout ask --to lattices#claude?sonnet "take task B"',
  ].join("\n");
}

export function renderScoutAskReceipt(value: {
  receipt: ScoutAskReceipt;
  replyMode: NonNullable<ScoutAskCommandOptions["replyMode"]>;
  flight?: ScoutFlightRecord | null;
}): string {
  const { ids } = value.receipt;
  const pieces = [
    ids.targetAgentId ? `asked ${ids.targetAgentId}` : "ask queued",
    ids.flightId ? `flight ${ids.flightId}` : null,
    ids.conversationId ? renderConversationRoute(ids.conversationId) : null,
    ids.sessionAlias ? `alias ${ids.sessionAlias}` : null,
    renderBindingRef(ids.bindingRef),
  ].filter((piece): piece is string => Boolean(piece));
  const delivery = renderScoutAskDeliveryStatus(value.flight);
  const suffix = value.replyMode === "notify"
    ? delivery
      ? `${delivery} Scout will surface the completion when it arrives.`
      : "Scout will surface the completion when it arrives."
    : delivery
      ? `${delivery} ${ids.invocationId ? `Next: scout wait ${ids.invocationId} --timeout 600` : "Follow the ask receipt to continue."}`
      : ids.invocationId
        ? `Next: scout wait ${ids.invocationId} --timeout 600`
        : "Follow the ask receipt to continue.";
  return `${pieces.join(" · ")}. ${suffix}`;
}

function renderScoutAskDeliveryStatus(
  flight?: ScoutFlightRecord | null,
): string | null {
  if (!flight) {
    return null;
  }

  const detail = flight.error ?? flight.summary ?? flight.output;
  const renderedDetail = detail ? ` ${detail}` : "";
  if (flight.state === "running" || flight.state === "waiting") {
    return `Dispatch acknowledged:${renderedDetail}`;
  }
  if (flight.state === "completed") {
    return `Completed:${renderedDetail}`;
  }
  if (flight.state === "failed" || flight.state === "cancelled") {
    return `Dispatch ${flight.state}:${renderedDetail}`;
  }
  if (flight.state === "queued" && isStoredUntilOnlineFlight(flight)) {
    return `Queued until target is online:${renderedDetail}`;
  }
  if (flight.state === "queued" || flight.state === "waking") {
    return `Dispatch ${flight.state}:${renderedDetail}`;
  }
  return `Dispatch state ${flight.state}:${renderedDetail}`;
}

function renderScoutTargetLabel(targetLabel: string): string {
  const trimmed = targetLabel.trim();
  if (
    trimmed.startsWith("@")
    || /^(?:ref|session|target|target-handle|target_handle|channel):/i.test(trimmed)
    || /^broadcast$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return `@${trimmed}`;
}

function renderScoutUpCommand(projectRoot: string): string {
  return `scout up "${projectRoot}"`;
}

function renderAmbiguousCandidate(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function renderConversationRoute(conversationId?: string): string {
  if (!conversationId) {
    return "conversation";
  }
  return conversationId.startsWith("dm.")
    ? `DM ${conversationId}`
    : `conversation ${conversationId}`;
}

function waitReferenceForFlight(flight: ScoutFlightRecord): string {
  return flight.invocationId || flight.id;
}

function isStoredUntilOnlineFlight(flight: ScoutFlightRecord): boolean {
  const dispatchOutcome = flight.metadata?.dispatchOutcome;
  if (
    dispatchOutcome
    && typeof dispatchOutcome === "object"
    && !Array.isArray(dispatchOutcome)
    && (dispatchOutcome as { status?: unknown }).status === "queued_until_online"
  ) {
    return true;
  }
  return /will deliver when online|message stored/i.test(flight.summary ?? "");
}

function isSettledInitialDispatchFlight(flight: ScoutFlightRecord): boolean {
  if (flight.state === "running"
    || flight.state === "waiting"
    || flight.state === "completed"
    || flight.state === "failed"
    || flight.state === "cancelled") {
    return true;
  }
  return flight.state === "queued";
}

async function loadInitialScoutAskFlight(
  brokerUrl: string,
  flightId: string,
  timeoutMs = DEFAULT_ASK_DISPATCH_SETTLE_MS,
): Promise<ScoutFlightRecord | null> {
  const deadline = Date.now() + timeoutMs;
  let latest: ScoutFlightRecord | null = null;
  while (Date.now() < deadline) {
    latest = await loadScoutFlight(brokerUrl, flightId);
    if (!latest || isSettledInitialDispatchFlight(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return latest ?? await loadScoutFlight(brokerUrl, flightId);
}

function renderBindingRef(bindingRef?: string | null): string | null {
  if (!bindingRef) {
    return null;
  }
  return bindingRef.startsWith("ref:") ? bindingRef : `ref:${bindingRef}`;
}

function formatScoutAskReceiptError(
  receipt: ScoutAskReceipt,
  targetLabel: string | undefined,
): string {
  const renderedTarget = targetLabel
    ? renderScoutTargetLabel(targetLabel)
    : "the requested project";
  if (receipt.state === "ambiguous") {
    return receipt.next?.reason
      ? `${receipt.next.reason} Nothing was sent.`
      : `target ${renderedTarget} matches multiple agents; nothing was sent. Re-run with a fully qualified @handle or exact session:<id> to disambiguate.`;
  }
  if (receipt.error) {
    return receipt.error.message;
  }
  if (receipt.next) {
    return `target ${renderedTarget} is not currently routable; nothing was sent. ${receipt.next.reason}`;
  }
  return `target ${renderedTarget} is not currently routable; nothing was sent.`;
}

export function formatScoutAskRoutingError(
  result: Pick<ScoutAskResult, "targetDiagnostic">,
  targetLabel: string,
): string {
  const renderedTarget = renderScoutTargetLabel(targetLabel);
  const diagnostic = result.targetDiagnostic;

  if (diagnostic?.state === "ambiguous") {
    const rendered = diagnostic.candidates
      .map((candidate) =>
        renderAmbiguousCandidate(candidate.label || candidate.agentId),
      )
      .filter((label) => label.length > 0);
    if (rendered.length > 0) {
      return `target ${renderedTarget} matches multiple agents: ${rendered.join(", ")}. Re-run with the fully qualified form (e.g. \`scout ask --to ${rendered[0].replace(/^@/, "")} ...\`).`;
    }
    if (diagnostic.detail) {
      return `${diagnostic.detail} Nothing was sent.`;
    }
    return `target ${renderedTarget} matches multiple agents; nothing was sent. Re-run with a fully qualified @handle to disambiguate.`;
  }

  if (diagnostic?.state === "discovered") {
    if (diagnostic.projectRoot) {
      return `target ${renderedTarget} is discovered but not online yet; nothing was sent. Start it with \`${renderScoutUpCommand(diagnostic.projectRoot)}\` or wait for it to come online.`;
    }
    return `target ${renderedTarget} is discovered but not online yet; nothing was sent. Run \`scout who\` to inspect the target, then start its project before retrying.`;
  }

  if (diagnostic?.state === "offline") {
    if (diagnostic.projectRoot) {
      return `target ${renderedTarget} is offline; nothing was sent. Start it with \`${renderScoutUpCommand(diagnostic.projectRoot)}\` or bring it back online before retrying.`;
    }
    return `target ${renderedTarget} is offline; nothing was sent. Run \`scout who\` to inspect the target before retrying.`;
  }

  if (diagnostic?.state === "unavailable") {
    const runtime = diagnostic.transport ? ` (${diagnostic.transport})` : "";
    const wakePolicy = diagnostic.wakePolicy ? ` [wake:${diagnostic.wakePolicy}]` : "";
    return `target ${renderedTarget} is known but currently unavailable${runtime}${wakePolicy}; nothing was sent. ${diagnostic.detail}`;
  }

  if (diagnostic?.state === "unknown") {
    return `there is no ${renderedTarget}; nothing was sent.`;
  }

  if (diagnostic?.state === "invalid" || diagnostic?.state === "missing") {
    return `${diagnostic.detail}; nothing was sent.`;
  }

  return `target ${renderedTarget} is not currently routable; nothing was sent.`;
}

export async function runAskCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderAskCommandHelp());
    return;
  }

  const options = parseAskCommandOptions(
    args,
    defaultScoutContextDirectory(context),
  );
  await runAskWithOptions(context, options);
}

export async function runAskWithOptions(
  context: ScoutCommandContext,
  options: ScoutAskCommandOptions,
): Promise<void> {
  const currentDirectory =
    options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(
    resolveHumanAskSenderName(options.agentName, context.env),
    currentDirectory,
    context.env,
  );
  const body = await resolvePromptBody(options);
  const to = options.targetRef
    ? `ref:${options.targetRef}`
    : options.targetLabel;
  const target:
    | { to: string; projectPath?: never; runtimeProfile?: never; existingHandle?: never }
    | { to?: never; projectPath: string; runtimeProfile?: never; existingHandle?: never }
    | { to?: never; projectPath?: string; runtimeProfile: string; existingHandle?: never }
    | { to?: never; projectPath?: never; runtimeProfile?: never; existingHandle: string } =
    options.runtimeProfile
      ? {
          runtimeProfile: options.runtimeProfile,
          ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        }
      : options.existingTargetHandle
      ? { existingHandle: options.existingTargetHandle }
      : options.projectPath
      ? { projectPath: options.projectPath }
      : { to: to ?? "" };
  const replyMode = options.replyMode ?? "inline";
  const receipt = await scoutAskHandler({
    senderId,
    ...target,
    body,
    channel: options.channel,
    harness: parseScoutHarness(options.harness),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    placement: options.placement,
    runtimeLiteral: options.runtimeLiteral,
    executionSource: options.executionSource,
    session: options.session,
    labels: options.labels,
    replyMode,
    currentDirectory,
    source: "scout-cli",
    aliasScope: options.aliasProject || options.aliasHost ? {
      ...(options.aliasProject ? { projectRoot: options.aliasProject } : {}),
      ...(options.aliasHost ? { nodeId: options.aliasHost } : {}),
    } : undefined,
  });

  if (!receipt.ok || !receipt.ids.flightId) {
    throw new Error(formatScoutAskReceiptError(
      receipt,
      options.targetLabel
        ?? options.existingTargetHandle
        ?? (options.runtimeProfile ? `profile:${options.runtimeProfile}` : undefined),
    ));
  }

  context.stderr(
    `asking ${receipt.ids.targetAgentId ?? options.targetLabel ?? options.existingTargetHandle ?? options.runtimeProfile ?? options.projectPath ?? "target"} as ${senderId} via ${renderConversationRoute(receipt.ids.conversationId)}... (flight ${receipt.ids.flightId})`,
  );

  if (replyMode !== "inline") {
    const flight = receipt.ids.flightId
      ? await loadInitialScoutAskFlight(resolveScoutBrokerUrl(), receipt.ids.flightId)
        .catch(() => null)
      : null;
    context.output.writeValue(
      {
        senderId,
        conversationId: receipt.ids.conversationId ?? null,
        messageId: receipt.ids.messageId ?? null,
        bindingRef: renderBindingRef(receipt.ids.bindingRef),
        receipt,
        replyMode,
        flight,
      },
      renderScoutAskReceipt,
    );
    return;
  }

  const brokerUrl = resolveScoutBrokerUrl();
  let completed: ScoutFlightRecord;
  let timedOut = false;
  try {
    completed = await waitForScoutFlight(
      brokerUrl,
      receipt.ids.flightId,
      {
        timeoutSeconds: options.timeoutSeconds ?? DEFAULT_ASK_ACK_TIMEOUT_SECONDS,
        waitUntil: "acknowledged",
        onUpdate: (_flight, detail) => context.stderr(detail),
      },
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Timed out waiting for flight")) {
      throw error;
    }
    timedOut = true;
    completed = await loadScoutFlight(brokerUrl, receipt.ids.flightId) ?? {
      id: receipt.ids.flightId,
      invocationId: receipt.ids.invocationId ?? receipt.ids.flightId,
      requesterId: senderId,
      targetAgentId: receipt.ids.targetAgentId ?? options.targetLabel ?? options.existingTargetHandle ?? options.runtimeProfile ?? options.projectPath ?? "target",
      state: "queued",
    };
  }

  context.output.writeValue(
    {
      senderId,
      conversationId: receipt.ids.conversationId ?? null,
      messageId: receipt.ids.messageId ?? null,
      bindingRef: renderBindingRef(receipt.ids.bindingRef),
      receipt,
      flight: completed,
      output: renderScoutAskInlineResult({
        conversationId: receipt.ids.conversationId ?? null,
        messageId: receipt.ids.messageId ?? null,
        bindingRef: renderBindingRef(receipt.ids.bindingRef),
        sessionAlias: receipt.ids.sessionAlias ?? null,
        flight: completed,
        timedOut,
      }),
    },
    (value) => value.output,
  );
}

function renderScoutAskInlineResult(value: {
  conversationId?: string | null;
  messageId?: string | null;
  bindingRef?: string | null;
  sessionAlias?: string | null;
  flight: ScoutFlightRecord;
  timedOut?: boolean;
}): string {
  if (value.flight.state === "completed") {
    return value.flight.output ?? value.flight.summary ?? "";
  }

  const pieces = [
    value.timedOut
      ? `not yet acknowledged ${value.flight.targetAgentId}`
      : `acknowledged ${value.flight.targetAgentId}`,
    `state ${value.flight.state}`,
    `flight ${value.flight.id}`,
    value.conversationId ? renderConversationRoute(value.conversationId) : null,
    value.sessionAlias ? `alias ${value.sessionAlias}` : null,
    value.bindingRef,
  ].filter((piece): piece is string => Boolean(piece));
  return `${pieces.join(" · ")}. Next: scout wait ${waitReferenceForFlight(value.flight)} --timeout 600.`;
}
