import Link from 'next/link';
import { Info, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { ConversationAiStatus } from '@/lib/conversations/contracts';

/**
 * States what sending a message does, and what it does not guarantee. Never calls the
 * conversation read-only, sandboxed or isolated: none of the conversation controls is verified.
 */
export const ConversationAiNotice = ({ ai }: { ai: ConversationAiStatus }) => {
  if (!ai.enabled) {
    return (
      <Alert variant="warning">
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>
          {ai.reason === 'stale' ? 'The AI Conversations disclosure changed' : 'AI replies are off'}
        </AlertTitle>
        <AlertDescription>
          <p>
            You can still save notes. To send messages to Claude Code or Codex, read and accept the
            AI Conversations disclosure in{' '}
            <Link href="/settings" className="text-primary underline underline-offset-4">
              Settings
            </Link>
            . Task execution consent does not enable conversations.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="info">
      <Info aria-hidden="true" />
      <AlertTitle>Planning conversation</AlertTitle>
      <AlertDescription>
        <p>
          Messages you send go to the selected CLI under your local login, together with earlier
          chat messages; notes stay here. The CLI runs in an empty scratch directory, with all tools
          disabled for Claude Code and the read-only sandbox for Codex. These are CLI settings, not
          OS-enforced isolation. Conversations never create tasks, worktrees, commits or pushes.
        </p>
      </AlertDescription>
    </Alert>
  );
};
