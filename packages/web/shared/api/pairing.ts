import { z } from "zod";

export const pairingControlBody = z.object({
  action: z.enum(["start", "stop", "restart"]),
});
export type PairingControlBody = z.input<typeof pairingControlBody>;
