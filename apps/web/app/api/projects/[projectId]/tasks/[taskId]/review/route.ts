import { taskReviewGet } from '@/lib/server/review-route';

/** Read-only review of the latest run: metadata, integrity outcome and change inventory. */
export const GET = taskReviewGet;
