import { z } from "zod";

// An attachment a client sends with a message. The server still drops any
// that name no way to fetch the bytes (neither url nor blobKey).
export const outgoingAttachment = z.object({
  id: z.string().optional(),
  mediaType: z.string(),
  fileName: z.string().optional(),
  blobKey: z.string().optional(),
  url: z.string().optional(),
});
export type OutgoingAttachment = z.input<typeof outgoingAttachment>;
