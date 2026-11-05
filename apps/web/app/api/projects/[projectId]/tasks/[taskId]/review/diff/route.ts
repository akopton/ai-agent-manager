import { taskReviewDiffGet } from '@/lib/server/review-route';

/** Read-only unified diff of one changed file (`?path=`), limited to the change inventory. */
export const GET = taskReviewDiffGet;
