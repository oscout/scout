export type ChatControlResult = {
  ok: boolean;
  messageId?: string | null;
  flightId?: string | null;
  lifecycleState?: string | null;
  delivery?: { state: "accepted" | "recoverable" } | null;
};

type ReconciledMessage = {
  clientMessageId?: string | null;
  optimistic?: boolean;
};

/**
 * A successful bridge reply proves acceptance, but the most useful receipt
 * still comes from the broker's durable result. Keep those states distinct
 * from transport failures, which the caller renders as delivery unconfirmed.
 */
export function acceptedSendLabel(result: ChatControlResult): string {
  if (!result.ok) {
    throw new Error("A rejected send does not have an accepted delivery label.");
  }
  if (result.delivery?.state === "recoverable") return "Needs attention";
  if (result.lifecycleState) return result.lifecycleState.replaceAll("_", " ");
  if (result.flightId) return "Dispatching";
  if (result.messageId) return "Posted";
  return "Accepted";
}

/**
 * Refresh replaces an optimistic send only after the authoritative ledger
 * echoes its stable client id. Unrelated in-flight sends remain visible.
 */
export function reconcileAuthoritativeMessages<T extends ReconciledMessage>(
  current: readonly T[],
  authoritative: readonly T[],
): T[] {
  const echoedClientIds = new Set(
    authoritative
      .map((message) => message.clientMessageId?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  const pending = current.filter((message) => {
    if (!message.optimistic) return false;
    const clientId = message.clientMessageId?.trim();
    return !clientId || !echoedClientIds.has(clientId);
  });
  return [...authoritative, ...pending];
}
