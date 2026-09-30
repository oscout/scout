import { z } from "zod";

export const blobUploadBody = z.object({
  data: z.string().optional(),
  mediaType: z.string().optional(),
  fileName: z.string().optional(),
});
export type BlobUploadBody = z.input<typeof blobUploadBody>;
