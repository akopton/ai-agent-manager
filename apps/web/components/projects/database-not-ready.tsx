import { DatabaseZap } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export const DatabaseNotReady = ({ message }: { message: string }) => (
  <Alert variant="warning">
    <DatabaseZap aria-hidden="true" />
    <AlertTitle>The project database is not ready</AlertTitle>
    <AlertDescription>
      <p>{message}</p>
    </AlertDescription>
  </Alert>
);
