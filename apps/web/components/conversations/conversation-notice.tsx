import { Info } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * States plainly that C1 has no AI replies, so a saved note is never mistaken for a sent message.
 */
export const NotesOnlyNotice = () => (
  <Alert variant="info">
    <Info aria-hidden="true" />
    <AlertTitle>AI replies are not enabled yet</AlertTitle>
    <AlertDescription>
      <p>
        Conversations currently store your notes and settings only. Nothing is sent to Claude Code
        or Codex, and no agent, task or Git operation is started. CLI-backed replies arrive in C2.
      </p>
    </AlertDescription>
  </Alert>
);
