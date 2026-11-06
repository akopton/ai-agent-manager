// Main navigation matching, kept free of React so it can be tested directly.

export type MainNavKey = 'overview' | 'projects' | 'conversations' | 'settings';

/** Project conversation pages live under the project URL but belong to the Conversations area. */
const projectConversationsPattern = /^\/projects\/[^/]+\/conversations(?:\/|$)/;

const startsWith = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

/** The navigation entry that represents `pathname`, or `undefined` for none. */
export const activeMainNavKey = (pathname: string): MainNavKey | undefined => {
  if (pathname === '/') return 'overview';
  if (startsWith(pathname, '/conversations') || projectConversationsPattern.test(pathname)) {
    return 'conversations';
  }
  if (startsWith(pathname, '/projects')) return 'projects';
  if (startsWith(pathname, '/settings')) return 'settings';
  return undefined;
};
