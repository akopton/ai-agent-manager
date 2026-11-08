/** One outer geometry for the app; content width limits belong inside it. */
export const pageGutterClassName = 'px-4 sm:px-6';
export const pageSpacingClassName = 'space-y-4';
export const contentWidthClassNames = {
  workspace: 'w-full',
  reading: 'w-full max-w-6xl',
  form: 'w-full max-w-3xl',
} as const;

export type ContentWidth = keyof typeof contentWidthClassNames;

/** Registration is a global form; every existing project's descendants share the viewport shell. */
export const isProjectWorkspacePath = (pathname: string): boolean =>
  /^\/projects\/(?!new(?:\/|$))[^/]+(?:\/|$)/.test(pathname);

export const isProjectConversationsPath = (pathname: string): boolean =>
  /^\/projects\/[^/]+\/conversations(?:\/|$)/.test(pathname);

export const isConversationDetailPath = (pathname: string): boolean =>
  /^\/projects\/[^/]+\/conversations\/(?!new(?:\/|$))[^/]+\/?$/.test(pathname);
