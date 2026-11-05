import { DatabaseNotReadyError } from '@/lib/server/database';

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Runs a server-side read for a page. A database that is not ready becomes a renderable state with
 * an actionable message; every other error propagates to the route's error boundary.
 */
export const loadForPage = async <T>(read: () => T | Promise<T>): Promise<Loaded<T>> => {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    if (error instanceof DatabaseNotReadyError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
};
