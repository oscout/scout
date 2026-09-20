import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScoutCommandContext } from "../context.ts";

type Membership = { origin: string; channelId: string; title: string; space: string; token: string; actorId: string; sessionId?: string; cursor?: string | null };
type State = { active?: string; rooms: Record<string, Membership>; attempts: Record<string, string> };

export function parseChatInvite(value: string): { origin: string; token: string; polling: boolean } {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS Scout invitation URL without embedded credentials.");
  const match = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)(?:\/(agent|api)\.md)?\/?$/);
  if (!match) throw new Error("Expected a Scout /invite/ link.");
  return { origin: url.origin, token: match[1]!, polling: match[2] === "api" };
}

export function currentChatSession(env: NodeJS.ProcessEnv): string | undefined {
  return env.GROK_SESSION_ID || env.CODEX_THREAD_ID || env.OPENSCOUT_CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_REMOTE_SESSION_ID || env.OPENSCOUT_SESSION_ID;
}

export function chatPath(room: Membership, resource: string): string {
  return `/api/channels/${encodeURIComponent(room.channelId)}/${resource}?space=${encodeURIComponent(room.space)}`;
}

export async function chatRequest(origin: string, path: string, input: { token?: string; body?: unknown; fetcher?: typeof fetch } = {}) {
  let response: Response;
  try { response = await (input.fetcher ?? fetch)(new URL(path, origin), {
    method: input.body === undefined ? "GET" : "POST",
    headers: { ...(input.token ? { authorization: `Bearer ${input.token}` } : {}), ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    redirect: "error", signal: AbortSignal.timeout(30_000),
  }); } catch {
    throw new Error("Chat connection failed or timed out. Retry the same operation; invitation and credential details are withheld.");
  }
  if (!response.ok) {
    if (response.status === 409 && new URL(path, origin).pathname.endsWith("/poll")) {
      const detail = await response.json().catch(() => null);
      if (detail?.reason === "stale") throw new Error("Chat history moved past the saved cursor. Read the room, then run watch --reset-cursor to replay retained history. Deduplicate by message id; older messages may be unavailable.");
    }
    const error = new Error(`Chat request failed (${response.status}). ${response.status === 401 ? "Your membership expired or was revoked; join again." : response.status === 410 ? "The invitation expired. Request a new invitation." : "No automatic mutation retry was attempted."}`);
    throw error;
  }
  let data: any;
  try { data = await response.json(); } catch { throw new Error("Chat returned invalid JSON. Response contents withheld to protect credentials."); }
  return { data, cookie: response.headers.get("set-cookie") };
}

export function renderChatHelp(commandName = "scout chat"): string {
  return `Scout Chat — join once, then participate in the same room.

  ${commandName} join <invite-url> [--name <name>] [--poll]
  ${commandName} read [--channel <id>]
  ${commandName} say "Hello" [--request-id <id>]
  ${commandName} reply <message-id> "My reply" [--request-id <id>]
  ${commandName} react <message-id> <emoji> [--request-id <id>]
  ${commandName} unreact <message-id> <emoji> [--request-id <id>]
  ${commandName} watch [--for 10m] [--once] [--compact] [--reset-cursor] [--channel <id>]
  ${commandName} status

Every invitation joins through the room HTTP API. No local broker, profile,
daemon, or session registration is needed. Read replies with read or watch;
joining does not enable automatic wake-up or broker-dispatched work.
Credentials and selected room are stored privately per working directory and
session. --channel selects a previously joined room. --json emits structured
results and never prints credentials. Watch only reads; it executes no tasks.
For a short listen, run ${commandName} watch --once --compact --for 30s --json. It waits in the
foreground until messages arrive or the timeout expires, then exits. --once skips
your own messages; --compact keeps only fields needed to read and reply. Answer relevant messages
with reply; ignore your own messages. Run watch again to resume from its saved
cursor. If history has expired, read the room, then explicitly use watch
--reset-cursor to replay retained history. Deduplicate by message id.
Listening does not itself generate replies.
Use the same --request-id to retry a send whose outcome was uncertain.
React and unreact acknowledge a message without posting a turn. They never
wake an agent or create a flight.`;
}

export async function runChatCommand(context: ScoutCommandContext, args: string[], commandName = "scout chat"): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h")) { context.output.writeText(renderChatHelp(commandName)); return; }
  const positional: string[] = []; const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["--poll", "--once", "--compact", "--reset-cursor"].includes(arg)) flags[arg.slice(2)] = "true";
    else if (["--name", "--channel", "--request-id", "--for"].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown chat option: ${arg}`);
    else positional.push(arg);
  }
  const [command, ...values] = positional;
  const scope = createHash("sha256").update(`${context.cwd}\n${currentChatSession(context.env) ?? "shell"}`).digest("hex");
  const directory = join(context.env.OPENSCOUT_CHAT_HOME ?? join(homedir(), ".openscout", "chat"), scope);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, "membership.json");
  let state: State;
  try { state = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { rooms: {}, attempts: {} }; }
  const save = async () => { const temporary = `${file}.${randomUUID()}`; await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, file); };
  if (command === "join") {
    if (values.length !== 1) throw new Error(`Usage: ${commandName} join <invite-url>`);
    const invite = parseChatInvite(values[0]!);
    const attempt = createHash("sha256").update(`${invite.origin}/${invite.token}`).digest("hex");
    state.attempts[attempt] ??= randomUUID();
    // Persist retry identity and prove credential storage is writable BEFORE consuming a use.
    await save();
    const { data, cookie } = await chatRequest(invite.origin, `/api/invites/${invite.token}/participate`, {
      body: { participantKey: state.attempts[attempt], displayName: flags.name ?? "Scout CLI agent" },
    });
    const token = data.credential?.token ?? cookie?.match(/(?:^|;\s*)openscout_member=([^;]+)/)?.[1];
    if (!data.ok || !data.conversationId || !token) throw new Error("Join response did not confirm membership and credentials. Retry the same invitation; do not create another identity.");
    const room: Membership = { origin: invite.origin, channelId: data.conversationId, title: data.channelTitle ?? "channel", space: data.space?.slug ?? "home", token, actorId: data.actorId };
    const key = `${room.origin}/${room.channelId}`;
    state.rooms[key] = room; state.active = key; await save();
    context.output.writeValue({ joined: true, channelId: room.channelId, title: room.title, space: room.space, mode: "polling", attached: false }, r => `Joined ${r.space} / #${r.title}.\nNext: ${commandName} say "Hello!"\nTo listen: ${commandName} watch --once --compact --for 30s --json\nWatch returns message records with IDs. Reply with ${commandName} reply <message-id> "Your reply". Repeat watch while participating; it resumes from the saved cursor. No background service is started.`);
    return;
  }
  const matching = flags.channel ? Object.values(state.rooms).filter(r => r.channelId === flags.channel) : [state.rooms[state.active ?? ""]].filter(Boolean);
  if (matching.length !== 1) throw new Error("Join a room first, or select one unambiguous joined room with --channel.");
  const room = matching[0]!;
  if (command === "status") { context.output.writeValue({ channelId: room.channelId, title: room.title, space: room.space, mode: room.sessionId ? "session" : "polling" }, r => `${r.space} / #${r.title} — ${r.mode}`); return; }
  if (command === "read") {
    const { data } = await chatRequest(room.origin, chatPath(room, "feed"), { token: room.token });
    context.output.writeValue(data, d => JSON.stringify(d, null, 2)); return;
  }
  if (command === "react" || command === "unreact") {
    const messageId = values[0]?.trim();
    const emoji = values[1]?.trim();
    if (!messageId || !emoji) throw new Error(`Usage: ${commandName} ${command} <message-id> <emoji>`);
    const requestId = flags["request-id"] ?? randomUUID();
    const resource = command === "unreact" ? "reactions/remove" : "reactions";
    try {
      const { data } = await chatRequest(room.origin, chatPath(room, resource), {
        token: room.token,
        body: { requestId, messageId, emoji },
      });
      context.output.writeValue(
        { ...data, requestId, messageId, emoji },
        () => `${command === "unreact" ? "Removed" : "Reacted"} ${emoji} on ${messageId}.`,
      );
    } catch (error) {
      throw new Error(`${(error as Error).message} Retry with --request-id ${requestId} to avoid duplicates.`);
    }
    return;
  }
  if (command === "say" || command === "reply") {
    const replyToMessageId = command === "reply" ? values.shift() : undefined;
    const body = values.join(" ").trim();
    if (!body || (command === "reply" && !replyToMessageId)) throw new Error("Provide message text and, for reply, the parent message id.");
    const requestId = flags["request-id"] ?? randomUUID();
    try {
      const { data } = await chatRequest(room.origin, chatPath(room, "messages"), { token: room.token, body: { requestId, body, ...(replyToMessageId ? { replyToMessageId } : {}) } });
      context.output.writeValue({ ...data, requestId }, d => `Posted ${d.message?.id ?? "message"}.\nTo listen for replies: ${commandName} watch --once --compact --for 30s --json\nAfter watch returns, answer relevant messages with ${commandName} reply <message-id> "Your reply". Ignore your own messages. Repeat watch for the agreed participation period.`);
    } catch (error) { throw new Error(`${(error as Error).message} Retry with --request-id ${requestId} to avoid duplicates.`); }
    return;
  }
  if (command === "watch") {
    const duration = flags.for ?? "10m";
    const match = duration.match(/^(\d+)(s|m)$/);
    const milliseconds = match ? Number(match[1]) * (match[2] === "m" ? 60_000 : 1000) : 0;
    if (milliseconds < 1000 || milliseconds > 3_600_000) throw new Error("Watch duration must be between 1s and 60m.");
    const cursorFile = join(directory, `cursor-${createHash("sha256").update(`${room.origin}/${room.channelId}`).digest("hex")}.json`);
    if (flags["reset-cursor"]) {
      await rm(cursorFile, { force: true });
      room.cursor = null;
    }
    try { room.cursor = JSON.parse(await readFile(cursorFile, "utf8")).cursor; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      const path = chatPath(room, "poll") + (room.cursor ? `&cursor=${encodeURIComponent(room.cursor)}` : "");
      const { data } = await chatRequest(room.origin, path, { token: room.token });
      const messages = (data.messages ?? []).filter((event: any) => !flags.once || event.actorId !== room.actorId);
      for (const event of messages) context.stdout(JSON.stringify(flags.compact
        ? { id: event.id, actorId: event.actorId, actorName: event.actorName, body: event.body, replyToMessageId: event.replyToMessageId }
        : event));
      room.cursor = data.nextCursor;
      const temporaryCursor = `${cursorFile}.${randomUUID()}`;
      await writeFile(temporaryCursor, JSON.stringify({ cursor: room.cursor }), { mode: 0o600 });
      await rename(temporaryCursor, cursorFile);
      if (flags.once && messages.length) return;
      const delay = data.hasMore ? 0 : Math.max(1000, Math.min(30_000, Number(data.recommendedPollIntervalMs) || 3000));
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
    }
    return;
  }
  throw new Error(`Unknown chat command: ${command}. Use ${commandName} --help.`);
}
