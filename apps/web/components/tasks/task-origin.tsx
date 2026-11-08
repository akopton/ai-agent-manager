import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { conversationUrl } from '@/lib/conversations/format';
import { messageAnchor } from '@/lib/conversations/proposals';

type TaskOriginView = {
  conversationId: string;
  conversationTitle: string | null;
  sourceMessageId: string | null;
  excerpt: string | null;
};

export const TaskOrigin = ({
  projectId,
  origin,
}: {
  projectId: string;
  origin: TaskOriginView;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>Task origin</h2>
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>Approved AI task proposal · Historical conversation content</p>
      {origin.conversationTitle === null ? (
        <p className="text-muted-foreground">The source conversation is no longer available.</p>
      ) : (
        <Link
          href={`${conversationUrl(projectId, origin.conversationId)}${origin.sourceMessageId === null ? '' : `#${messageAnchor(origin.sourceMessageId)}`}`}
          className="inline-flex min-h-9 items-center rounded-sm break-words text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {origin.sourceMessageId === null ? 'Open conversation' : 'Open source reply'}:{' '}
          {origin.conversationTitle}
        </Link>
      )}
      {origin.excerpt === null ? (
        <p className="text-xs text-muted-foreground">
          No source reply preview is available for this proposal.
        </p>
      ) : (
        <blockquote className="rounded-lg border bg-inset p-3 text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
          {origin.excerpt.length > 600
            ? `${origin.excerpt.slice(0, 600).trimEnd()}…`
            : origin.excerpt}
        </blockquote>
      )}
    </CardContent>
  </Card>
);
