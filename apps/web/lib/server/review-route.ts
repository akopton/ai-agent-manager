import { fileDiffQuerySchema, requestChangesRequestSchema } from '@/lib/review/contracts';
import {
  errorResponse,
  guardContentRead,
  handleRouteError,
  jsonResponse,
  parseMutationRequest,
} from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { getTaskReview, getTaskReviewFileDiff, requestChangesForTask } from '@/lib/server/review';

// Review Changes routes. The GET routes are read-only, run no agent and change nothing: the server
// resolves the worktree from the task's stored workspace record, never from the request. The
// Request Changes POST records feedback and the named `request_changes` transition only.

type RouteContext = { params: Promise<{ projectId: string; taskId: string }> };

/** `GET`: review metadata and the change inventory of the task's latest run. */
export const taskReviewGet = async (
  request: Request,
  { params }: RouteContext,
): Promise<Response> => {
  const rejected = guardContentRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, taskId } = await params;
    return jsonResponse({ review: await getTaskReview(getDatabase(), projectId, taskId) });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** `GET ?path=`: the unified diff of one file listed by the change inventory. */
export const taskReviewDiffGet = async (
  request: Request,
  { params }: RouteContext,
): Promise<Response> => {
  const rejected = guardContentRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  const query = fileDiffQuerySchema.safeParse({
    path: new URL(request.url).searchParams.get('path') ?? '',
  });
  if (!query.success) {
    return errorResponse(
      'invalid_request',
      query.error.issues[0]?.message ?? 'The path is invalid.',
      400,
    );
  }
  try {
    const { projectId, taskId } = await params;
    return jsonResponse({
      diff: await getTaskReviewFileDiff(getDatabase(), projectId, taskId, query.data.path),
    });
  } catch (error) {
    return handleRouteError(error);
  }
};

/**
 * `POST {runId, revision, feedback}`: Request Changes for the reviewed attempt. Same Host/Origin
 * and JSON guards as every mutation. Returns 201; never starts an agent.
 */
export const taskRequestChangesPost = async (
  request: Request,
  { params }: RouteContext,
): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, requestChangesRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, taskId } = await params;
    return jsonResponse(await requestChangesForTask(getDatabase(), projectId, taskId, data), 201);
  } catch (error) {
    return handleRouteError(error);
  }
};
