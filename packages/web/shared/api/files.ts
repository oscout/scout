import { z } from "zod";

export const projectAddBody = z.object({
  root: z.string().optional(),
});
export type ProjectAddBody = z.input<typeof projectAddBody>;
