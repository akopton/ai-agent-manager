import { projectNameMaxLength } from '@ai-agent-manager/core';

// One-time success messages are passed to the next page in the URL, so they survive the navigation
// and need no client-side state.

type SearchParams = Record<string, string | string[] | undefined>;

export const savedProjectUrl = (projectId: string): string => `/projects/${projectId}?saved=1`;

export const disconnectedProjectsUrl = (name: string): string =>
  `/projects?${new URLSearchParams({ disconnected: name }).toString()}`;

export const wasProjectSaved = (searchParams: SearchParams): boolean => searchParams.saved === '1';

/** The disconnected project's name for the confirmation message, if present and plausible. */
export const readDisconnectedName = (searchParams: SearchParams): string | undefined => {
  const value = searchParams.disconnected;
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim();
  return name.length > 0 && name.length <= projectNameMaxLength ? name : undefined;
};
