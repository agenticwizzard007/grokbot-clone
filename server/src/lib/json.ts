import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

/** Thrown by readJson so a handler can bail out with a 400 without its own try/catch. */
export class InvalidJsonBody extends Error {
  readonly status = 400;
  constructor(message = 'Invalid JSON body') { super(message); this.name = 'InvalidJsonBody'; }
}

type ReadJsonResult<T> = { ok: true; data: T } | { ok: false; response: Response };

/**
 * Reads a JSON object body. Malformed JSON, an empty body, arrays and scalars yield a 400 response
 * `{"error":"Invalid JSON body"}` instead of an unhandled exception.
 *
 *   const body = await readJson(c); if (!body.ok) return body.response;
 *
 * With a zod schema the parsed value is validated too, and a validation failure is also a 400.
 */
export async function readJson<T = Record<string, any>>(c: Context, schema?: z.ZodType<T>): Promise<ReadJsonResult<T>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return { ok: false, response: c.json({ error: 'Invalid JSON body' }, 400) }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, response: c.json({ error: 'Invalid JSON body' }, 400) };
  if (!schema) return { ok: true, data: raw as T };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: c.json({ error: zodMessage(parsed.error), details: zodDetails(parsed.error) }, 400) };
  return { ok: true, data: parsed.data };
}

/** Same as readJson, but throws InvalidJsonBody / ZodError for the app error handler to turn into a 400. */
export async function jsonBody<T = Record<string, any>>(c: Context, schema?: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new InvalidJsonBody(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidJsonBody();
  return schema ? schema.parse(raw) : raw as T;
}

const zodDetails = (error: z.ZodError) => error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

/** A short, user-readable message for the first issue (no stack, no internal values). */
export function zodMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid request.';
  const field = first.path.map(String).join('.');
  return field ? `Invalid ${field}: ${first.message}` : `Invalid request: ${first.message}`;
}

/**
 * App level error handler: invalid JSON and validation errors become 400s with a short message,
 * everything else is a generic 500. Stack traces are logged on the server, never sent to the client.
 */
export const apiErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof z.ZodError) return c.json({ error: zodMessage(err), details: zodDetails(err) }, 400);
  if (err instanceof InvalidJsonBody) return c.json({ error: err.message }, 400);
  // Hono's c.req.json() throws a SyntaxError on malformed JSON in routes that do not use readJson.
  if (err instanceof SyntaxError && !['GET', 'HEAD'].includes(c.req.method)) return c.json({ error: 'Invalid JSON body' }, 400);
  console.error('[api]', err);
  return c.json({ error: 'Internal server error' }, 500);
};
