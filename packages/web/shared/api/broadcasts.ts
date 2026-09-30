// One-line fleet broadcasts, as GET /api/broadcast/recent and the
// /api/broadcast/stream SSE feed serve them.

export type BroadcastTier = "info" | "warn" | "error";

export type Broadcast = {
  id: string;
  tier: BroadcastTier;
  text: string;
  agent?: string;
  project?: string;
  ts: number;
  ruleId: string;
  key: string;
};
