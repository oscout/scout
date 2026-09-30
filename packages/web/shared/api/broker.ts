import { z } from "zod";

// Omitted and null both read as null, the way the diagnostics rows carry them.
const nullableString = z.string().nullish().transform((value) => value ?? null);

// One broker diagnostics row, as GET /api/broker served it. Dispatch review
// accepts the snapshot the operator inspected when the row id is synthesized,
// and clients send those snapshots with empty fields left out.
export const brokerRouteAttempt = z.object({
  id: z.string(),
  kind: z.enum(["success", "failed_query", "failed_delivery", "delivery_attempt"]),
  status: z.string(),
  ts: z.number().optional().transform((value) => value ?? 0),
  actorName: nullableString,
  target: nullableString,
  route: nullableString,
  detail: z.string().optional().transform((value) => value ?? ""),
  conversationId: nullableString,
  messageId: nullableString,
  deliveryId: nullableString,
  invocationId: nullableString,
  metadata: z.record(z.string(), z.unknown()).nullish().transform((value) => value ?? null),
});

export const brokerDispatchReviewBody = z.object({
  attemptId: z.string().optional(),
  attempt: brokerRouteAttempt.optional(),
});
export type BrokerDispatchReviewBody = z.input<typeof brokerDispatchReviewBody>;
