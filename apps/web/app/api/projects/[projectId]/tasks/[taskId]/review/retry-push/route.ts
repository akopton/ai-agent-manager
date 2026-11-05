import { taskRetryPushPost } from '@/lib/server/review-route';

/** Retry push: asks the worker to push the already recorded commit again (never a new commit). */
export const POST = taskRetryPushPost;
