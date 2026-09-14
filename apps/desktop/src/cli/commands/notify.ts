import { basename, extname, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { resolvePairingPort } from "@openscout/runtime/local-config";
import { defaultScoutContextDirectory, type ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl, resolveScoutSenderId, sendScoutMessage } from "../../core/broker/service.ts";
import { storePairingAttachmentBlob } from "../../core/pairing/runtime/bridge/fileserver.ts";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function renderNotifyCommandHelp(): string {
  return [
    "Usage: scout notify --message <text> [--image <path>] [--as <sender>] [--json]",
    "",
    "Send your operator a deliberate message and keep working. No flight or waiting state is created.",
    "The operating agent decides when the user's condition is met; this command does not schedule checks.",
    "The remote push is generic. Open Scout to read the authored message and image.",
    "Delivery is best-effort: a receipt confirms recording, not notification display or reading.",
    "Images: PNG, JPEG, GIF, WebP; up to 25 MiB. Requires a local broker and pairing file server.",
    "Image bytes use the existing paired attachment store and expire after six hours.",
    "",
    '  scout notify --message "The screen is ready for review." --image ./screen.png',
    '  scout notify --message "The investigation found a reason to change our plan."',
  ].join("\n");
}

export function parseNotifyCommandOptions(args: string[]) {
  const result: { message: string; image?: string; sender?: string; cwd?: string; help: boolean } = { message: "", help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { ...result, help: true };
    if (arg === "--json") continue;
    const key = ({ "--message": "message", "--image": "image", "--as": "sender", "--cwd": "cwd" } as const)[arg as "--message"];
    if (!key) throw new ScoutCliError(`unknown notify option: ${arg}`);
    const value = args[++i];
    if (!value?.trim() || value.startsWith("--")) throw new ScoutCliError(`${arg} requires a non-empty value`);
    result[key] = value.trim();
  }
  if (!result.message) throw new ScoutCliError("notify requires --message <text>");
  return result;
}

export async function runNotifyCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseNotifyCommandOptions(args.length ? args : ["--help"]);
  if (options.help) { context.output.writeText(renderNotifyCommandHelp()); return; }
  const currentDirectory = options.cwd ?? defaultScoutContextDirectory(context);
  let attachment: ReturnType<typeof storePairingAttachmentBlob> | undefined;
  if (options.image) {
    const host = new URL(resolveScoutBrokerUrl()).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      throw new ScoutCliError("--image requires a local broker; run this command on the broker's machine");
    }
    const path = resolve(currentDirectory, options.image);
    const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mediaType) throw new ScoutCliError("--image must be PNG, JPEG, GIF, or WebP");
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > MAX_IMAGE_BYTES) throw new ScoutCliError("image must be a non-empty file of at most 25 MiB");
    attachment = storePairingAttachmentBlob({
      data: (await readFile(path)).toString("base64"), mediaType, fileName: basename(path),
    }, { port: resolvePairingPort() + 2 });
  }
  const senderId = await resolveScoutSenderId(options.sender, currentDirectory, context.env);
  const result = await sendScoutMessage({
    senderId, currentDirectory, targetLabel: "operator", body: options.message, source: "scout-notify",
    operatorSignal: { kind: "notify", blocking: false, replyExpectation: "none" },
    attachments: attachment ? [attachment] : undefined,
  });
  if (!result.usedBroker || result.routingError || result.unresolvedTargets.length || !result.messageId) {
    throw new ScoutCliError("operator notification was not recorded; check broker availability and routing");
  }
  context.output.writeValue({
    status: "recorded", notificationDelivery: "unconfirmed", senderId,
    messageId: result.messageId, conversationId: result.conversationId,
    imageExpiresAt: attachment?.expiresAt ?? null,
  }, value => [
    "Operator message recorded; notification delivery is unconfirmed. Continue working.",
    `Message: ${value.messageId}. Conversation: ${value.conversationId}.`,
    ...(value.imageExpiresAt ? [`Image available until ${new Date(value.imageExpiresAt).toISOString()}.`] : []),
  ].join("\n"));
}
