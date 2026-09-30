import type { Context } from "hono";
import type { z } from "zod";

export type JsonBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: Response };

// Reads a JSON request body and checks it against `schema`. A missing or
// malformed body reads as `{}`, so an all-optional schema keeps the route's
// own "x is required" messages; a body of the wrong shape answers 400 naming
// the first bad field instead of reaching the handler as a lying cast.
export async function readJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<JsonBodyResult<z.output<S>>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, response: c.json({ error: describeBodyIssue(parsed.error) }, 400) };
}

function describeBodyIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body.";
  const field = issue.path.map(String).join(".");
  return field ? `Invalid request body: ${field}: ${issue.message}` : `Invalid request body: ${issue.message}`;
}
