import type { z } from 'zod';
import { apiErrorResponseSchema } from '@/lib/projects/contracts';

export type ClientError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ClientResult<T> = { ok: true; data: T } | { ok: false; error: ClientError };

/**
 * Sends a request to a same-origin API route and validates the response with `schema`. A `body`
 * is sent as JSON; without one, no body or content type is sent.
 */
export const requestJson = async <T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<ClientResult<T>> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return {
      ok: false,
      error: {
        code: 'network_error',
        message: 'The local server could not be reached. Check that it is running and try again.',
      },
    };
  }

  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : {
          ok: false,
          error: { code: 'invalid_response', message: 'The server sent an unexpected response.' },
        };
  }

  const parsedError = apiErrorResponseSchema.safeParse(json);
  return {
    ok: false,
    error: parsedError.success
      ? parsedError.data.error
      : { code: 'http_error', message: `The request failed (HTTP ${response.status}).` },
  };
};

/** POSTs JSON to a same-origin API route and validates the response with `schema`. */
export const postJson = <T>(
  url: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<ClientResult<T>> => requestJson('POST', url, schema, body);
