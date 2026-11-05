import { taskApprovePost } from '@/lib/server/review-route';

/**
 * Approve & Push: records the operator's confirmed approval of the reviewed change set (201). The
 * worker commits it on the task branch and pushes that branch; this request mutates no repository.
 */
export const POST = taskApprovePost;
