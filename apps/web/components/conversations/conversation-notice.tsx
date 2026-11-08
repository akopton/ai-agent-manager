import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import type { ConversationAiStatus } from '@/lib/conversations/contracts';

/** Only actionable blockers live here. Full global disclosure is in App Settings. */
export const ConversationAiNotice = ({
  ai,
  projectId,
  sourceBlocked = false,
}: {
  ai: ConversationAiStatus;
  projectId?: string;
  sourceBlocked?: boolean;
}) => {
  if (ai.enabled && !sourceBlocked) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 rounded-lg border border-warning/30 px-3 py-2 text-xs text-warning"
    >
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        {ai.enabled ? null : (
          <p>
            {ai.reason === 'stale'
              ? 'The AI Conversations disclosure changed.'
              : 'AI replies are off.'}{' '}
            <Link
              href="/settings#ai-conversations"
              className="rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Review AI Conversations in App Settings
            </Link>
            .
          </p>
        )}
        {!sourceBlocked || projectId === undefined ? null : (
          <p>
            Project-Aware source sharing is not allowed yet.{' '}
            <Link
              href={`/projects/${projectId}/settings#source-sharing`}
              className="rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Allow source sharing in Project Settings
            </Link>{' '}
            or choose General Chat in conversation settings.
          </p>
        )}
      </div>
    </div>
  );
};
