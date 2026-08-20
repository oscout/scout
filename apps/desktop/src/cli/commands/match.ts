import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  SCOUT_RENDEZVOUS_MAX_WAIT_MS,
  isScoutRendezvousFailureResponse,
  validateScoutRendezvousCodename,
  type ScoutRendezvousRequest,
  type ScoutRendezvousResponse,
} from "@openscout/protocol";
import { findNearestProjectRoot } from "@openscout/runtime/setup";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  matchScoutRendezvous,
  resolveScoutMatchParticipantId,
  resolveScoutSenderId,
  sendScoutMessage,
  type ScoutMessagePostResult,
} from "../../core/broker/service.ts";
import { renderScoutMessagePostResult } from "../../ui/terminal/broker.ts";
import { formatScoutSendRoutingError } from "./send.ts";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

type MatchCommandOptions = {
  action: "create" | "join";
  sessionId: string | null;
  projectPath: string | null;
  codename: string | null;
  message: string | null;
  waitMs: number;
};

export type MatchCommandDependencies = {
  matchRendezvous: (
    request: ScoutRendezvousRequest,
  ) => Promise<ScoutRendezvousResponse>;
  resolveParticipantId: typeof resolveScoutMatchParticipantId;
  resolveSenderId: typeof resolveScoutSenderId;
  sendMessage: typeof sendScoutMessage;
  now: () => number;
};

const DEFAULT_MATCH_COMMAND_DEPENDENCIES: MatchCommandDependencies = {
  matchRendezvous: matchScoutRendezvous,
  resolveParticipantId: resolveScoutMatchParticipantId,
  resolveSenderId: resolveScoutSenderId,
  sendMessage: sendScoutMessage,
  now: Date.now,
};

export function renderMatchCommandHelp(): string {
  return [
    "Usage:",
    "  scout match new <codename> [--message <text>] [--session <id>] [--project <path>]",
    "  scout match new [--message <text>] [--session <id>] [--project <path>]",
    "  scout match <codename> [--session <id>] [--project <path>] [--wait <seconds>]",
    "",
    "Create or join a private two-session match in the current project.",
    "",
    "The facilitator chooses a memorable codename, gives it to both sessions, and",
    "runs `scout match new <codename>`. The other session runs",
    "`scout match <codename>`. Codenames match case-insensitively within one project,",
    "expire after 4 hours, and match exactly two live sessions. With --message,",
    "the creator sends one exact-session message only after the broker confirms the match.",
    "",
    "Examples:",
    "  scout match new BLUEBIRD",
    '  scout match new BLUEBIRD --message "hello from A"',
    "  scout match bluebird",
    "  scout match new  # generated fallback",
  ].join("\n");
}

export function parseMatchCommandOptions(args: string[]): MatchCommandOptions {
  let sessionId: string | null = null;
  let projectPath: string | null = null;
  let message: string | null = null;
  let waitMs = SCOUT_RENDEZVOUS_MAX_WAIT_MS;
  let waitProvided = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--session" || arg.startsWith("--session=")) {
      const parsed = flagValue(args, index, "--session");
      sessionId = parsed.value;
      index = parsed.index;
      continue;
    }
    if (arg === "--project" || arg.startsWith("--project=")) {
      const parsed = flagValue(args, index, "--project");
      projectPath = parsed.value;
      index = parsed.index;
      continue;
    }
    if (arg === "--message" || arg.startsWith("--message=")) {
      const parsed = flagValue(args, index, "--message");
      message = parsed.value;
      index = parsed.index;
      continue;
    }
    if (arg === "--wait" || arg.startsWith("--wait=")) {
      const parsed = flagValue(args, index, "--wait");
      const seconds = Number(parsed.value);
      if (
        !Number.isFinite(seconds)
        || seconds < 0
        || seconds * 1_000 > SCOUT_RENDEZVOUS_MAX_WAIT_MS
      ) {
        throw new ScoutCliError(
          `--wait must be between 0 and ${SCOUT_RENDEZVOUS_MAX_WAIT_MS / 1_000} seconds`,
        );
      }
      waitMs = Math.round(seconds * 1_000);
      waitProvided = true;
      index = parsed.index;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ScoutCliError(`unexpected argument for match: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length < 1 || positionals.length > 2) {
    throw new ScoutCliError(renderMatchCommandHelp());
  }
  const value = positionals[0]!.trim();
  if (value.toLocaleLowerCase("en-US") === "new") {
    if (waitProvided) {
      throw new ScoutCliError(
        "scout match new creates a fixed 10-minute invitation; --wait is only valid when joining",
      );
    }
    let codename: string | null = null;
    if (positionals[1]) {
      try {
        codename = validateScoutRendezvousCodename(positionals[1]);
      } catch (error) {
        throw new ScoutCliError(error instanceof Error ? error.message : String(error));
      }
    }
    return {
      action: "create",
      sessionId,
      projectPath,
      codename,
      message,
      waitMs: SCOUT_RENDEZVOUS_MAX_WAIT_MS,
    };
  }
  if (positionals.length !== 1) {
    throw new ScoutCliError(renderMatchCommandHelp());
  }
  if (message !== null) {
    throw new ScoutCliError("--message is only valid when creating a match");
  }
  try {
    return {
      action: "join",
      sessionId,
      projectPath,
      codename: validateScoutRendezvousCodename(value),
      message: null,
      waitMs,
    };
  } catch (error) {
    throw new ScoutCliError(error instanceof Error ? error.message : String(error));
  }
}

export async function runMatchCommand(
  context: ScoutCommandContext,
  args: string[],
  dependencies: MatchCommandDependencies = DEFAULT_MATCH_COMMAND_DEPENDENCIES,
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderMatchCommandHelp());
    return;
  }
  const options = parseMatchCommandOptions(args);
  const contextDirectory = defaultScoutContextDirectory(context);
  const projectRoot = await resolveMatchProjectRoot(options.projectPath, contextDirectory);
  const participantId = await dependencies.resolveParticipantId(
    options.sessionId,
    context.env,
  );

  if (context.output.mode === "plain" && options.action === "join" && options.waitMs > 0) {
    context.stderr(
      `Joining Scout match ${options.codename} in ${basename(projectRoot)}…`,
    );
  }

  if (options.action === "join") {
    const response = await dependencies.matchRendezvous({
      action: "join",
      codename: options.codename!,
      projectRoot,
      participantId,
      waitMs: options.waitMs,
    });
    writeMatchResult(context, response);
    return;
  }

  const created = await dependencies.matchRendezvous({
    action: "create",
    ...(options.codename ? { codename: options.codename } : {}),
    projectRoot,
    participantId,
  });
  writeMatchResult(context, created);
  if (created.status !== "created") {
    return;
  }
  if (context.output.mode === "plain") {
    context.stderr(`Waiting for the other session in ${basename(projectRoot)}…`);
  }
  const remainingMs = Math.max(0, created.expiresAt - dependencies.now());
  const terminal = await dependencies.matchRendezvous({
    action: "join",
    codename: created.codename,
    projectRoot,
    participantId,
    waitMs: Math.min(SCOUT_RENDEZVOUS_MAX_WAIT_MS, remainingMs),
  });
  writeMatchResult(context, terminal);
  if (terminal.status === "matched" && options.message) {
    await sendMatchedMessage(
      context,
      terminal,
      options.message,
      projectRoot,
      dependencies,
    );
  }
}

async function sendMatchedMessage(
  context: ScoutCommandContext,
  match: Extract<ScoutRendezvousResponse, { status: "matched" }>,
  message: string,
  projectRoot: string,
  dependencies: MatchCommandDependencies,
): Promise<void> {
  const targetSessionId = match.peerParticipantIds[0];
  if (!targetSessionId?.startsWith("session:")) {
    throw new ScoutCliError(
      "the broker confirmed a match without an exact peer session; the message was not sent",
    );
  }
  const senderId = await dependencies.resolveSenderId(null, projectRoot, context.env);
  const result = await dependencies.sendMessage({
    senderId,
    body: message,
    targetLabel: targetSessionId,
    currentDirectory: projectRoot,
    source: "scout-cli-match",
  });
  assertMatchedMessageSent(result);

  context.output.writeValue(
    {
      status: "message_sent",
      codename: match.codename,
      targetSessionId,
      senderId,
      conversationId: result.conversationId,
      messageId: result.messageId,
      message,
      bindingRef: result.bindingRef,
      flightId: result.flight?.id,
      invokedTargets: result.invokedTargets,
      unresolvedTargets: result.unresolvedTargets,
      routeKind: result.routeKind,
    },
    renderScoutMessagePostResult,
  );
}

function assertMatchedMessageSent(result: ScoutMessagePostResult): void {
  if (!result.usedBroker) {
    throw new ScoutCliError(
      "the match completed, but the message was not sent because the broker is not reachable",
    );
  }
  if (result.unresolvedTargets.length > 0) {
    throw new ScoutCliError(
      `the match completed, but the message was not sent: ${formatScoutSendRoutingError(result)}`,
    );
  }
  if (result.routingError) {
    throw new ScoutCliError(
      `the match completed, but the message was not sent: ${result.routingError}`,
    );
  }
  if (!result.conversationId || !result.messageId) {
    throw new ScoutCliError(
      "the match completed, but the broker returned no durable message receipt",
    );
  }
}

function writeMatchResult(
  context: ScoutCommandContext,
  response: ScoutRendezvousResponse,
): void {
  if (isScoutRendezvousFailureResponse(response)) {
    if (context.output.mode === "json") {
      context.stdout(JSON.stringify(response));
    }
    throw new ScoutCliError(renderMatchResponse(response));
  }
  if (context.output.mode === "json") {
    context.stdout(JSON.stringify(
      response.status === "matched"
        ? { ...response, communication: buildMatchCommunicationGuide(response) }
        : response,
    ));
    return;
  }
  context.output.writeValue(response, renderMatchResponse);
}

async function resolveMatchProjectRoot(
  projectPath: string | null,
  currentDirectory: string,
): Promise<string> {
  if (projectPath) {
    try {
      return await realpath(resolve(currentDirectory, projectPath));
    } catch {
      throw new ScoutCliError(`match project path does not exist: ${projectPath}`);
    }
  }
  const nearest = await findNearestProjectRoot(currentDirectory);
  if (!nearest) {
    throw new ScoutCliError(
      "scout match requires a project scope; run inside a project or pass --project <path>",
    );
  }
  try {
    return await realpath(nearest);
  } catch {
    return resolve(nearest);
  }
}

export function renderMatchResponse(response: ScoutRendezvousResponse): string {
  const projectName = basename(response.projectRoot);
  if (response.status === "created") {
    const seconds = Math.max(0, Math.ceil((response.expiresAt - Date.now()) / 1_000));
    return [
      `Match codename: ${response.codename}`,
      `Give the other session: scout match ${response.codename}`,
      `Valid for ${formatMatchDuration(seconds)} in ${projectName}.`,
    ].join("\n");
  }
  if (response.status === "matched") {
    const guide = buildMatchCommunicationGuide(response);
    return [
      `Matched with ${guide.peerSessionIds.join(", ")} in ${projectName}.`,
      `Temporary handoff: ${response.matchId}`,
      "Connection ready. Both sessions should now use this exact-session route:",
      `Send: ${guide.sendCommand}`,
      `Inbox: ${guide.inboxCommand}`,
      `Project: ${guide.projectRoot}`,
      `First exchange: ${guide.coordinationChecklist.join(", ")}.`,
      guide.deliveryNote,
    ].join("\n");
  }
  if (response.status === "codename_busy") {
    return `Match ${response.codename} is already reserved or full in ${projectName}. Choose another codename.`;
  }
  if (response.status === "not_found") {
    return `No active match ${response.codename} exists in ${projectName}. Check the codename or create it with scout match new ${response.codename}.`;
  }
  if (response.status === "expired") {
    return `Match ${response.codename} expired in ${projectName}. Recreate it with scout match new ${response.codename}.`;
  }
  if (response.status === "consumed") {
    return `Match ${response.codename} was already used in ${projectName}. Choose another codename.`;
  }
  if (response.status === "project_mismatch") {
    return `Match ${response.codename} belongs to another project. Run this command from the same project as the invitation owner.`;
  }
  const seconds = Math.max(0, Math.ceil((response.expiresAt - Date.now()) / 1_000));
  return `Match ${response.codename} is still waiting in ${projectName}; it expires in ${formatMatchDuration(seconds)}.`;
}

function buildMatchCommunicationGuide(
  response: Extract<ScoutRendezvousResponse, { status: "matched" }>,
) {
  const peerSessionIds = [...response.peerParticipantIds];
  const target = peerSessionIds[0] ?? "session:<peer>";
  return {
    peerSessionIds,
    projectRoot: response.projectRoot,
    sendCommand: `scout send --to ${target} "<message>"`,
    inboxCommand: "scout inbox --latest 10 --json",
    coordinationChecklist: [
      "worktree path or creation request",
      "base branch or SHA",
      "task branch",
      "touched paths",
      "commit and merge policy",
    ],
    deliveryNote:
      "A durable send receipt means the message is stored even if the peer is busy or unreachable. Read replies with the inbox command above; do not create another match.",
  };
}

function formatMatchDuration(seconds: number): string {
  if (seconds >= 120 && seconds % 60 === 0) {
    return `${seconds / 60} minutes`;
  }
  return `${seconds} seconds`;
}

function flagValue(
  args: string[],
  index: number,
  flag: string,
): { value: string; index: number } {
  const current = args[index] ?? "";
  if (current.startsWith(`${flag}=`)) {
    const value = current.slice(flag.length + 1).trim();
    if (!value) throw new ScoutCliError(`missing value for ${flag}`);
    return { value, index };
  }
  const value = args[index + 1]?.trim();
  if (!value) throw new ScoutCliError(`missing value for ${flag}`);
  return { value, index: index + 1 };
}
