import { TaskError, type TaskErrorCode } from '@ai-agent-manager/core';
import type { z } from 'zod';
import type { ApiErrorCode, ApiErrorResponse } from '@/lib/projects/contracts';
import { DatabaseNotReadyError } from '@/lib/server/database';
import { ProjectServiceError, type ProjectServiceErrorCode } from '@/lib/server/projects';
import { checkHost, checkMutationRequest } from '@/lib/server/request-guard';

const maxBodyBytes = 64 * 1024;
const noStore = { 'Cache-Control': 'no-store' };

export const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStore });

export const errorResponse = (
  code: ApiErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): Response => {
  const body: ApiErrorResponse = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return jsonResponse(body, status);
};

const serviceErrorStatus = (code: ProjectServiceErrorCode): number => {
  switch (code) {
    case 'project_already_registered':
    case 'project_has_dependents':
      return 409;
    case 'project_not_found':
      return 404;
    case 'repository_inspection_failed':
      return 500;
    default:
      return 422;
  }
};

const taskErrorStatus = (code: TaskErrorCode): number => {
  switch (code) {
    case 'invalid_task_input':
      return 400;
    case 'project_not_found':
    case 'task_not_found':
      return 404;
    case 'task_not_editable':
    case 'illegal_transition':
      return 409;
  }
};

/** Converts expected failures into structured responses; unexpected ones are logged. */
export const handleRouteError = (error: unknown): Response => {
  if (error instanceof ProjectServiceError) {
    return errorResponse(error.code, error.message, serviceErrorStatus(error.code), error.details);
  }
  if (error instanceof TaskError) {
    return errorResponse(error.code, error.message, taskErrorStatus(error.code), error.details);
  }
  if (error instanceof DatabaseNotReadyError) {
    return errorResponse('database_not_ready', error.message, 503);
  }
  console.error('Unexpected error in an API route.', error);
  return errorResponse('internal_error', 'An unexpected error occurred. See the server log.', 500);
};

/** Guards a read-only route. Returns a response to send when the request is rejected. */
export const guardRead = (request: Request): Response | undefined => {
  const failure = checkHost(request.headers);
  return failure === undefined ? undefined : errorResponse(failure.code, failure.message, 403);
};

/**
 * Guards a state-changing route without a request body (loopback Host and same-origin Origin).
 * Returns a response to send when the request is rejected.
 */
export const guardMutation = (request: Request): Response | undefined => {
  const failure = checkMutationRequest(request.headers);
  return failure === undefined ? undefined : errorResponse(failure.code, failure.message, 403);
};

type ParsedBody<T> = { data: T; response?: undefined } | { data?: undefined; response: Response };

/**
 * Guards a state-changing (or path-inspecting) route and parses its JSON body with `schema`. On
 * failure, `response` holds the structured error to return.
 */
export const parseMutationRequest = async <T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> => {
  const rejected = guardMutation(request);
  if (rejected !== undefined) {
    return { response: rejected };
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(?:;|$)/i.test(contentType)) {
    return {
      response: errorResponse('unsupported_media_type', 'Send the request as JSON.', 415),
    };
  }

  const text = await request.text();
  if (Buffer.byteLength(text) > maxBodyBytes) {
    return { response: errorResponse('payload_too_large', 'The request is too large.', 413) };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      response: errorResponse('invalid_request', 'The request body is not valid JSON.', 400),
    };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const fields = Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join('.') || 'body', issue.message]),
    );
    return {
      response: errorResponse(
        'invalid_request',
        parsed.error.issues[0]?.message ?? 'The request is invalid.',
        400,
        { fields },
      ),
    };
  }
  return { data: parsed.data };
};
