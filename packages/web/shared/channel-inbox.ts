/** Concern filtering is shared by the local and hosted adapters. Text is never routing. */
export type InboxReason = "mention" | "thread" | "reply" | "question";
export type InboxMessage = {
  id: string; actorId: string; replyToMessageId?: string | null;
  conversationId?: string; channelId?: string; threadConversationId?: string | null;
  mentions?: readonly { actorId: string }[];
};
export type InboxRequest = {
  messageId: string | null; targetActorId?: string;
  responsibility?: { actorId?: string };
};

export function filterChannelInbox<T extends InboxMessage>(
  page: readonly T[], history: readonly InboxMessage[], viewer: string,
  requests: readonly InboxRequest[] = [], questionMessageIds: ReadonlySet<string> = new Set(), participatedRoots: ReadonlySet<string> = new Set(),
) {
  const byId = new Map(history.map(message => [message.id, message]));
  const own = new Set(history.filter(message => message.actorId === viewer).map(message => message.id));
  const root = (message: InboxMessage): string => {
    const seen = new Set<string>();
    let current = message;
    while (current.replyToMessageId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.replyToMessageId);
      if (!parent) return current.replyToMessageId;
      current = parent;
    }
    return current.id;
  };
  const threads = new Set(history.filter(message => own.has(message.id)).map(root));
  const threadIds = new Set<string>();
  for (const message of history) if (own.has(message.id)) {
    if (message.threadConversationId) threadIds.add(message.threadConversationId);
    if (message.conversationId && message.conversationId !== message.channelId) threadIds.add(message.conversationId);
  }
  const questions = new Set(questionMessageIds);
  for (const request of requests) if (request.messageId && (request.targetActorId === viewer || request.responsibility?.actorId === viewer)) questions.add(request.messageId);
  const reasons: Record<string, InboxReason[]> = Object.create(null);
  const messages = page.filter(message => {
    if (message.actorId === viewer) return false;
    const why: InboxReason[] = [];
    if (message.mentions?.some(mention => mention.actorId === viewer)) why.push("mention");
    if (participatedRoots.has(root(message)) || threads.has(root(message)) || (message.conversationId && threadIds.has(message.conversationId))) why.push("thread");
    if (message.replyToMessageId && own.has(message.replyToMessageId)) why.push("reply");
    if (questions.has(message.id)) why.push("question");
    if (why.length) reasons[message.id] = why;
    return why.length > 0;
  });
  return { messages, reasons };
}

export function inboxWaitSeconds(value: string | null | undefined): number {
  if (value == null || value === "") return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 25) throw new Error("wait must be between 0 and 25 seconds");
  return seconds;
}

type HeldPage = { messages: readonly unknown[]; nextCursor: string | null; hasMore: boolean };
/** Validate/authenticate the initial page BEFORE committing headers. A later failure
 * terminates the stream (never an empty success), so clients retry the saved cursor. */
export function holdChannelInbox<T extends HeldPage>(request: Request, initial: T, wait: number,
  reload: (cursor: string | null) => Promise<T>,
  changes?: { wait: (signal: AbortSignal) => Promise<void>; release?: () => void }): Response {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  if (!wait || initial.messages.length) { changes?.release?.(); return new Response(JSON.stringify(initial), { headers }); }
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const waiting = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const encoder = new TextEncoder();
      const deadline = Date.now() + wait * 1000;
      let page = initial;
      const finish = () => { if (!closed) { controller.enqueue(encoder.encode(JSON.stringify(page))); cleanup(); controller.close(); } };
      const expiry = setTimeout(finish, wait * 1000);
      const cleanup = () => { if (closed) return; closed = true; waiting.abort(); changes?.release?.(); clearTimeout(expiry); clearInterval(heartbeat); clearTimeout(timer); wake?.(); request.signal.removeEventListener("abort", abort); };
      const abort = () => { if (!closed) { cleanup(); controller.error(new Error("Inbox request aborted")); } };
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(" ")); }, 4000);
      stop = cleanup;
      request.signal.addEventListener("abort", abort, { once: true });
      controller.enqueue(encoder.encode(" "));
      if (request.signal.aborted) { abort(); return; }
      void (async () => {
        try {
          while (!closed && !page.messages.length && Date.now() < deadline) {
            // No per-waiter polling: drain known backlog, otherwise await a signal.
            if (!page.hasMore) await (changes?.wait(waiting.signal) ?? new Promise<void>(resolve => { wake = resolve; }));
            else await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 0); });
            if (closed) return;
            page = await reload(page.nextCursor);
          }
          finish();
        } catch (error) { if (!closed) { cleanup(); controller.error(error); } }
      })();
    },
    cancel() { stop(); },
  });
  return new Response(body, { headers });
}
