export const conversationTabs = ['chat', 'tasks', 'notes'] as const;
export type ConversationTab = (typeof conversationTabs)[number];

/** Legacy source and batch anchors must reveal their destination even without a tab query. */
export const resolveConversationTab = (tab: string | null, hash = ''): ConversationTab => {
  if (hash.startsWith('#message-')) return 'chat';
  if (hash.startsWith('#proposals-')) return 'tasks';
  return tab === 'tasks' || tab === 'notes' ? tab : 'chat';
};

export const conversationTabUrl = (
  pathname: string,
  search: string,
  tab: ConversationTab,
): string => {
  const params = new URLSearchParams(search);
  params.set('tab', tab);
  return `${pathname}?${params.toString()}`;
};
